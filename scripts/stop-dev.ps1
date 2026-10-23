[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $repoRoot 'tmp\dev-services'
$stateFile = Join-Path $runtimeDir 'services.json'

if (-not (Test-Path $stateFile)) {
  Write-Host '[ACP] No managed development services were found.'
  exit 0
}

$state = Get-Content $stateFile -Raw | ConvertFrom-Json

function Get-ProcessTreeIds {
  param([int]$ProcessId)
  Write-Output $ProcessId
  foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)) {
    Get-ProcessTreeIds -ProcessId ([int]$child.ProcessId)
  }
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [string]$Marker,
    [string]$Label,
    [switch]$ChildProcess
  )

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    if (-not $ChildProcess) {
      Write-Host "[ACP] $Label is already stopped."
    }
    return
  }

  if (-not $ChildProcess -and ([string]::IsNullOrWhiteSpace($process.CommandLine) -or $process.CommandLine -notlike "*$Marker*")) {
    Write-Warning "$Label PID $ProcessId belongs to another process. It was not stopped."
    return
  }

  # Snapshot the entire tree before stopping supervisors; otherwise a watcher can restart a child
  # during shutdown, or an exiting intermediate shell can hide its still-running descendants.
  $processTree = @(Get-ProcessTreeIds -ProcessId $ProcessId)
  foreach ($treeProcessId in $processTree) {
    Stop-Process -Id $treeProcessId -Force -ErrorAction SilentlyContinue
  }
  if (-not $ChildProcess) {
    Write-Host "[ACP] Stopped $Label."
  }
}

foreach ($serviceName in @('web', 'api')) {
  $service = $state.$serviceName
  if ($null -eq $service -or $null -eq $service.pid) {
    continue
  }
  $label = if ($serviceName -eq 'api') { 'Core API' } else { 'Web UI' }
  Stop-ProcessTree -ProcessId ([int]$service.pid) -Marker ([string]$service.marker) -Label $label
}

Remove-Item -LiteralPath $stateFile -Force
Write-Host '[ACP] Development services are stopped.' -ForegroundColor Green
