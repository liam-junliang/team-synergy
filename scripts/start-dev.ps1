[CmdletBinding()]
param(
  [string]$DatabaseUrl = $env:ACP_DATABASE_URL,
  [int]$ApiPort = 8080,
  [int]$WebPort = 5173,
  [int]$StartupTimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $repoRoot 'tmp\dev-services'
$stateFile = Join-Path $runtimeDir 'services.json'
$startedAt = (Get-Date).ToString('o')
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $DatabaseUrl = 'postgres://postgres:postgres@127.0.0.1:5432/acp'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Write-Step {
  param([string]$Message)
  Write-Host "[ACP] $Message" -ForegroundColor Cyan
}

function Get-HttpStatus {
  param([string]$Url)

  try {
    $status = & curl.exe --noproxy '*' --silent --output NUL --write-out '%{http_code}' $Url 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $status) {
      return 0
    }
    return [int]$status
  } catch {
    return 0
  }
}

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMilliseconds = 1500
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
      return $false
    }
    $client.EndConnect($asyncResult)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-LocalPortInUse {
  param([int]$Port)

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  return $null -ne $listener
}

function Show-LogTail {
  param(
    [string]$Label,
    [string]$Path
  )

  if (Test-Path $Path) {
    Write-Host "`n$Label ($Path):" -ForegroundColor Yellow
    Get-Content $Path -Tail 30
  }
}

function Wait-ForService {
  param(
    [string]$Label,
    [string]$Url,
    [System.Diagnostics.Process]$Process,
    [string]$StdoutLog,
    [string]$StderrLog
  )

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-HttpStatus $Url) -eq 200) {
      return
    }
    if ($Process.HasExited) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  Show-LogTail "$Label stdout" $StdoutLog
  Show-LogTail "$Label stderr" $StderrLog
  throw "$Label failed to start. Health check did not reach $Url"
}

function Get-PreviousState {
  if (-not (Test-Path $stateFile)) {
    return $null
  }
  try {
    return Get-Content $stateFile -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-PreviousPid {
  param(
    [object]$PreviousState,
    [string]$ServiceName
  )

  if ($null -eq $PreviousState) {
    return $null
  }
  $service = $PreviousState.$ServiceName
  if ($null -eq $service -or $null -eq $service.pid) {
    return $null
  }
  $existingProcess = Get-Process -Id ([int]$service.pid) -ErrorAction SilentlyContinue
  if ($null -eq $existingProcess) {
    return $null
  }
  return [int]$service.pid
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($null -eq $pnpmCommand) {
  throw 'pnpm.cmd was not found. Install pnpm 10.33 or newer first.'
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw 'node.exe was not found. Install Node.js 22 or newer first.'
}

try {
  $databaseUri = [Uri]$DatabaseUrl
  $databaseHost = $databaseUri.Host
  $databasePort = $databaseUri.Port
  if ($databasePort -lt 1) {
    $databasePort = 5432
  }
} catch {
  throw 'ACP_DATABASE_URL is not a valid PostgreSQL connection string.'
}

Write-Step "Checking PostgreSQL at $databaseHost`:$databasePort"
if (-not (Test-TcpPort -HostName $databaseHost -Port $databasePort)) {
  throw "Cannot connect to PostgreSQL at $databaseHost`:$databasePort. Start PostgreSQL first."
}

$env:ACP_DATABASE_URL = $DatabaseUrl
$env:ACP_CORE_API_URL = "http://127.0.0.1:$ApiPort"
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = '127.0.0.1,localhost'
$previousState = Get-PreviousState

$apiUrl = "http://127.0.0.1:$ApiPort/health"
$apiStdout = Join-Path $runtimeDir "core-api-$timestamp.stdout.log"
$apiStderr = Join-Path $runtimeDir "core-api-$timestamp.stderr.log"
$apiProcess = $null
$apiPid = $null

if ((Get-HttpStatus $apiUrl) -eq 200) {
  Write-Step "Core API is already running at $apiUrl"
  $apiPid = Get-PreviousPid -PreviousState $previousState -ServiceName 'api'
} else {
  if (Test-LocalPortInUse $ApiPort) {
    throw "Port $ApiPort is occupied but its health check failed. Run pnpm dev:stop or release the port first."
  }

  Write-Step 'Starting Core API'
  $env:PORT = [string]$ApiPort
  $env:HOST = '127.0.0.1'
  $apiProcess = Start-Process `
    -FilePath $pnpmCommand.Source `
    -ArgumentList @('--filter', '@team-synergy/core-api', 'dev') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $apiStdout `
    -RedirectStandardError $apiStderr
  $apiPid = $apiProcess.Id
  Wait-ForService -Label 'Core API' -Url $apiUrl -Process $apiProcess -StdoutLog $apiStdout -StderrLog $apiStderr
  Write-Step "Core API is ready at $apiUrl"
}

$webUrl = "http://127.0.0.1:$WebPort"
$webStdout = Join-Path $runtimeDir "web-$timestamp.stdout.log"
$webStderr = Join-Path $runtimeDir "web-$timestamp.stderr.log"
$webProcess = $null
$webPid = $null

if ((Get-HttpStatus $webUrl) -eq 200) {
  Write-Step "Web UI is already running at $webUrl"
  $webPid = Get-PreviousPid -PreviousState $previousState -ServiceName 'web'
} else {
  if (Test-LocalPortInUse $WebPort) {
    throw "Port $WebPort is occupied but is not reachable through 127.0.0.1. Run pnpm dev:stop or release the port first."
  }

  Write-Step 'Starting Web UI'
  $webProcess = Start-Process `
    -FilePath $pnpmCommand.Source `
    -ArgumentList @('--filter', '@team-synergy/web', 'exec', 'vite', '--host', '0.0.0.0', '--port', [string]$WebPort, '--strictPort') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $webStdout `
    -RedirectStandardError $webStderr
  $webPid = $webProcess.Id
  Wait-ForService -Label 'Web UI' -Url $webUrl -Process $webProcess -StdoutLog $webStdout -StderrLog $webStderr
  Write-Step "Web UI is ready at $webUrl"
}

$state = @{
  repo_root = $repoRoot
  updated_at = $startedAt
  api = @{
    pid = $apiPid
    marker = '@team-synergy/core-api'
    url = $apiUrl
    stdout_log = $apiStdout
    stderr_log = $apiStderr
  }
  web = @{
    pid = $webPid
    marker = '@team-synergy/web'
    url = $webUrl
    stdout_log = $webStdout
    stderr_log = $webStderr
  }
}
$state | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding UTF8

Write-Host ''
Write-Host 'Team Synergy is running.' -ForegroundColor Green
Write-Host "Web UI:  $webUrl"
Write-Host "Core API: $apiUrl"
Write-Host "Logs:     $runtimeDir"
Write-Host 'Stop with: pnpm dev:stop'
