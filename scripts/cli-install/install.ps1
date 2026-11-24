param(
  [string]$BaseUrl,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TeamSynergy\cli'),
  [switch]$NoModifyPath,
  [string]$ExpectedCurrent,
  [string]$ExpectedSha256,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $Rollback) {
  $uri = [Uri]$BaseUrl
  if (-not $uri -or -not $uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback))) { throw 'BaseUrl must be an HTTPS API URL (HTTP is allowed only on localhost).' }
  $BaseUrl = $uri.AbsoluteUri.TrimEnd('/')
}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Only Windows x64 and ARM64 releases are supported.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir)) { throw 'Cannot install into a drive root.' }
function Assert-NoLinks([string]$Target) {
  $cursor = $Target
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Installation path contains a link: $cursor" } }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }; $cursor = $parent
  }
}
Assert-NoLinks $InstallDir
$marker = Join-Path $InstallDir '.tsp-install.json'
$pointer = Join-Path $InstallDir '.tsp-current'
$slotPattern = '^([0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16})-[a-zA-Z0-9]{8}$'
Assert-NoLinks $marker
Assert-NoLinks $pointer
if (Test-Path -LiteralPath $InstallDir) {
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Refusing to overwrite an unmanaged directory. Choose another InstallDir.' }
  if ((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).product -ne 'team-synergy-cli') { throw 'Invalid installation marker.' }
} else {
  if ($Rollback -or $ExpectedCurrent) { throw 'No managed CLI installation found.' }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  @{ product = 'team-synergy-cli' } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
}
$lockPath = Join-Path $InstallDir '.install.lock'
Assert-NoLinks $lockPath
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { throw "Another install is running, or an interrupted install left a lock: $lockPath" }
$stage = Join-Path $InstallDir ('.stage-' + [Guid]::NewGuid().ToString('N'))
function Move-Atomic([string]$Source, [string]$Target) {
  Assert-NoLinks $Target
  if ([IO.File]::Exists($Target)) {
    $backup = Join-Path $stage ('backup-' + [IO.Path]::GetFileName($Target))
    [IO.File]::Replace($Source, $Target, $backup)
  }
  else { [IO.File]::Move($Source, $Target) }
}
function Write-Pointer([string]$Current, [string]$Previous, [string]$Origin) {
  [IO.File]::WriteAllLines((Join-Path $stage 'pointer'), @($Current, $Previous, $Origin), [Text.UTF8Encoding]::new($false))
  Move-Atomic (Join-Path $stage 'pointer') $pointer
}
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  $previous = ''
  $installedOrigin = ''
  $hasPointer = [IO.File]::Exists($pointer)
  if ($hasPointer) {
    $current, $previous, $installedOrigin = [IO.File]::ReadAllLines($pointer)
    if ($current -cnotmatch $slotPattern) { throw 'Invalid current release pointer.' }
  } else {
    $legacy = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    $current = $legacy.directory
    $installedOrigin = $legacy.api_url
    if ($current -and $current -cnotmatch $slotPattern) { throw 'Invalid legacy installation marker.' }
  }
  if ($ExpectedCurrent -and $ExpectedCurrent -cne $current) { throw 'The installed release changed. Check again before switching releases.' }
  $versions = Join-Path $InstallDir 'versions'; $bin = Join-Path $InstallDir 'bin'
  Assert-NoLinks $versions; Assert-NoLinks $bin
  if ($Rollback) {
    if (-not $hasPointer -or $previous -cnotmatch $slotPattern -or $previous -ceq $current) { throw 'No previous CLI release is available.' }
    $previousRoot = Join-Path $versions $previous
    Assert-NoLinks $previousRoot
    foreach ($relative in @('runtime\node.exe', 'apps\cli\dist\index.js', 'apps\agentd\dist\index.js')) {
      $file = Join-Path $previousRoot $relative
      Assert-NoLinks $file
      if (-not [IO.File]::Exists($file)) { throw 'The previous CLI release is incomplete.' }
    }
    Write-Pointer $previous $current $installedOrigin
    Write-Output "Team Synergy CLI rolled back to $previous."
    return
  }
  $manifest = Invoke-RestMethod -Uri "$BaseUrl/cli/manifest.json" -UseBasicParsing -MaximumRedirection 0
  if ($manifest.schema_version -ne 1) { throw 'Unsupported CLI release manifest.' }
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $artifacts = @($manifest.artifacts | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq $architecture })
  if ($artifacts.Count -ne 1) { throw "This platform has not published a Windows $architecture CLI. Contact its administrator." }
  $artifact = $artifacts[0]
  if ($artifact.filename -notmatch '^tsp-[a-zA-Z0-9.-]+-win32-(x64|arm64)\.zip$' -or $artifact.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$' -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid CLI release manifest.' }
  if ($ExpectedSha256 -and $ExpectedSha256 -cne $artifact.sha256) { throw 'The published release changed. Check again before installing.' }
  $archive = Join-Path $stage 'release.zip'
  Invoke-WebRequest -Uri "$BaseUrl/cli/releases/$($artifact.filename)" -OutFile $archive -UseBasicParsing -MaximumRedirection 0
  $hasher = [Security.Cryptography.SHA256]::Create(); $archiveStream = [IO.File]::OpenRead($archive)
  try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() } finally { $archiveStream.Dispose(); $hasher.Dispose() }
  if ((Get-Item -LiteralPath $archive).Length -ne $artifact.size_bytes -or $actualHash -ne $artifact.sha256) { throw 'CLI archive checksum mismatch. Installation was not changed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^[/\\]|^[a-zA-Z]:|(^|[/\\])\.\.([/\\]|$))' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive entry.' }
    }
  } finally { $zip.Dispose() }
  $payload = Join-Path $stage 'payload'
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $payload)
  foreach ($relative in @('runtime\node.exe', 'apps\cli\dist\index.js', 'apps\agentd\dist\index.js')) {
    if (-not [IO.File]::Exists((Join-Path $payload $relative))) { throw 'Incomplete CLI release.' }
  }
  New-Item -ItemType Directory -Path $versions, $bin -Force | Out-Null
  Assert-NoLinks $versions; Assert-NoLinks $bin
  # Published version directories are immutable. A reinstall repairs using a fresh directory.
  $installedRelease = $artifact.release + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $destination = Join-Path $versions $installedRelease
  Move-Item -LiteralPath $payload -Destination $destination
  # While replacing legacy launchers, both old and new launchers still resolve to the old slot.
  if (-not $hasPointer -and $current) { Write-Pointer $current '' $installedOrigin }
  foreach ($command in @('tsp', 'agentd')) {
    $application = if ($command -eq 'tsp') { 'cli' } else { 'agentd' }
    $shim = @"
@echo off
setlocal DisableDelayedExpansion
set "TSP_CURRENT="
set /p "TSP_CURRENT="<"%~dp0..\.tsp-current"
if not defined TSP_CURRENT exit /b 1
"%~dp0..\versions\%TSP_CURRENT%\runtime\node.exe" "%~dp0..\versions\%TSP_CURRENT%\apps\$application\dist\index.js" %*
"@
    [IO.File]::WriteAllText((Join-Path $stage "$command.cmd"), $shim, [Text.Encoding]::ASCII)
    Move-Atomic (Join-Path $stage "$command.cmd") (Join-Path $bin "$command.cmd")
  }
  @{ product = 'team-synergy-cli'; release = $artifact.release; directory = $installedRelease; api_url = $BaseUrl } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'marker.json') -Encoding UTF8
  Move-Atomic (Join-Path $stage 'marker.json') $marker
  Write-Pointer $installedRelease $current $BaseUrl
  if (-not $NoModifyPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $remainingPath = (@($userPath -split ';') | Where-Object { $_ -and $_ -ne $bin }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $remainingPath).TrimEnd(';'), 'User')
    if (@($env:Path -split ';') -notcontains $bin) { $env:Path = $bin + ';' + $env:Path }
  }
  Write-Output "Team Synergy CLI installed: $bin\tsp.cmd"
  if (-not $ExpectedCurrent) { Write-Output "Open a new terminal, then authorize this client: tsp auth login --api $BaseUrl" }
} finally {
  $lock.Dispose()
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ne $InstallDir) { throw 'Unsafe stage cleanup.' }
  Assert-NoLinks $stage
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Remove-Item -LiteralPath $lockPath -Force
}
