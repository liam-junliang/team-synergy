param(
  [ValidateSet('start', 'status', 'stop')][string]$Action = 'status',
  [string]$RuntimeRoot = 'F:/workspace/team-knowledge-runtime/embedding-cpu',
  [string]$ModelsPath = 'D:/Software/Ollama/models',
  [ValidateRange(1, 65535)][int]$Port = 11435
)
$ErrorActionPreference = 'Stop'
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$profilePath = Join-Path $runtime 'deployment.json'
$baseUrl = "http://127.0.0.1:$Port"
$executable = (Get-Command ollama.exe -ErrorAction Stop).Source
$profile = if (Test-Path -LiteralPath $profilePath) { Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json } else { $null }
if ($profile -and $profile.baseUrl -ne $baseUrl) { throw 'CPU embedding profile uses a different endpoint.' }

function Get-OwnedTree {
  if (-not $profile -or -not $profile.pid) { throw 'CPU embedding process ownership metadata is missing.' }
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate)
  $owner = $all | Where-Object ProcessId -EQ ([int]$profile.pid) | Select-Object -First 1
  if (-not $owner -or -not [string]::Equals($owner.ExecutablePath, $executable, [StringComparison]::OrdinalIgnoreCase) -or
      $owner.CommandLine -notmatch '(?:^|\s)serve(?:\s|$)' -or
      -not $profile.createdAt -or [math]::Abs(($owner.CreationDate.ToUniversalTime() - [datetime]::Parse($profile.createdAt).ToUniversalTime()).TotalSeconds) -gt 1) {
    throw 'CPU embedding process ownership could not be verified.'
  }
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add([int]$owner.ProcessId)
  do {
    $added = $false
    foreach ($candidate in $all) {
      if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) { $added = $true }
    }
  } while ($added)
  return @($ids)
}
function Test-OwnedListener {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if (-not $listeners.Count) { return $false }
  $owned = @(Get-OwnedTree)
  foreach ($listener in $listeners) {
    if ($listener.LocalAddress -ne '127.0.0.1' -or $owned -notcontains [int]$listener.OwningProcess) { throw 'CPU embedding has an unrelated listener.' }
  }
  return $true
}
$hasListener = Test-OwnedListener
if ($Action -eq 'stop') {
  if ($profile -and (Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$profile.pid)")) {
    Get-OwnedTree | Out-Null
    taskkill.exe /PID ([int]$profile.pid) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'CPU embedding shutdown failed.' }
  }
  Write-Output '{"stopped":true,"modelsPreserved":true}'
  exit 0
}
if ($Action -eq 'start' -and -not $hasListener) {
  if ($profile -and (Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$profile.pid)")) { throw 'An owned CPU embedding process exists without its expected listener.' }
  $models = [IO.Path]::GetFullPath($ModelsPath)
  if (-not (Test-Path -LiteralPath (Join-Path $models 'manifests/registry.ollama.ai/library/bge-m3/latest'))) { throw 'Existing BGE-M3 model manifest not found; no download is performed.' }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  # Scoped to this launch process; never writes user or machine environment.
  $settings = @{ OLLAMA_HOST=$baseUrl; OLLAMA_MODELS=$models; CUDA_VISIBLE_DEVICES='-1'; OLLAMA_VULKAN='false';
    OLLAMA_NUM_PARALLEL='1'; OLLAMA_MAX_LOADED_MODELS='1'; OLLAMA_CONTEXT_LENGTH='4096'; OLLAMA_NO_CLOUD='true' }
  $previous = @{}
  try {
    foreach ($name in $settings.Keys) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process') }
    $child = Start-Process -FilePath $executable -ArgumentList 'serve' -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError (Join-Path $runtime 'stderr.log')
  } finally { foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
  if (-not $actual) { throw 'CPU embedding process exited at startup.' }
  $profile = [pscustomobject]@{ pid=$child.Id; executable=$executable; createdAt=$actual.CreationDate.ToUniversalTime().ToString('o'); baseUrl=$baseUrl; modelsPath=$models; cpuOnly=$true }
  $profile | ConvertTo-Json | Set-Content -LiteralPath $profilePath -Encoding utf8
  for ($attempt=0; $attempt -lt 60 -and -not (Test-OwnedListener); $attempt++) { Start-Sleep -Milliseconds 500 }
  $hasListener = Test-OwnedListener
  if (-not $hasListener) { throw 'CPU embedding listener timed out.' }
}
if (-not $hasListener) { Write-Output '{"healthy":false}'; exit 0 }
$version = Invoke-RestMethod "$baseUrl/api/version" -TimeoutSec 5
$tags = Invoke-RestMethod "$baseUrl/api/tags" -TimeoutSec 5
$model = $tags.models | Where-Object name -EQ 'bge-m3:latest' | Select-Object -First 1
if ($model.digest -ne '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab') { throw 'CPU embedding BGE-M3 digest differs from the verified model.' }
[pscustomobject]@{ healthy=$true; baseUrl=$baseUrl; version=$version.version; model='bge-m3'; digest=$model.digest; pid=$profile.pid; cpuPolicyConfigured=$true } | ConvertTo-Json
