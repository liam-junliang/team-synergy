param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TeamSynergy\cli'),
  [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$uri = [Uri]$BaseUrl
if (-not $uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback))) { throw 'BaseUrl must be an HTTPS API URL (HTTP is allowed only on localhost).' }
$BaseUrl = $BaseUrl.TrimEnd('/')
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
Assert-NoLinks $marker
if (Test-Path -LiteralPath $InstallDir) {
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Refusing to overwrite an unmanaged directory. Choose another InstallDir.' }
  if ((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).product -ne 'team-synergy-cli') { throw 'Invalid installation marker.' }
} else {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  @{ product = 'team-synergy-cli' } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
}
$lockPath = Join-Path $InstallDir '.install.lock'
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { throw "Another install is running, or an interrupted install left a lock: $lockPath" }
$stage = Join-Path $InstallDir ('.stage-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  $manifest = Invoke-RestMethod -Uri "$BaseUrl/cli/manifest.json" -UseBasicParsing
  if ($manifest.schema_version -ne 1) { throw 'Unsupported CLI release manifest.' }
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $artifacts = @($manifest.artifacts | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq $architecture })
  if ($artifacts.Count -ne 1) { throw "This platform has not published a Windows $architecture CLI. Contact its administrator." }
  $artifact = $artifacts[0]
  if ($artifact.filename -notmatch '^tsp-[a-zA-Z0-9.-]+-win32-(x64|arm64)\.zip$' -or $artifact.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}$' -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid CLI release manifest.' }
  $archive = Join-Path $stage 'release.zip'
  Invoke-WebRequest -Uri "$BaseUrl/cli/releases/$($artifact.filename)" -OutFile $archive -UseBasicParsing
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
  if (-not (Test-Path -LiteralPath (Join-Path $payload 'runtime\node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $payload 'apps\cli\dist\index.js'))) { throw 'Incomplete CLI release.' }
  $versions = Join-Path $InstallDir 'versions'; $bin = Join-Path $InstallDir 'bin'
  New-Item -ItemType Directory -Path $versions, $bin -Force | Out-Null
  Assert-NoLinks $versions; Assert-NoLinks $bin
  # Published version directories are immutable. A reinstall repairs using a fresh directory.
  $installedRelease = $artifact.release + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $destination = Join-Path $versions $installedRelease
  Move-Item -LiteralPath $payload -Destination $destination
  foreach ($command in @('tsp', 'agentd')) {
    $shim = "@echo off`r`ncall `"%~dp0..\versions\$installedRelease\$command.cmd`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $stage "$command.cmd"), $shim, [Text.Encoding]::ASCII)
    Move-Item -LiteralPath (Join-Path $stage "$command.cmd") -Destination (Join-Path $bin "$command.cmd") -Force
  }
  @{ product = 'team-synergy-cli'; release = $artifact.release; directory = $installedRelease; api_url = $BaseUrl } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
  if (-not $NoModifyPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $remainingPath = (@($userPath -split ';') | Where-Object { $_ -and $_ -ne $bin }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $remainingPath).TrimEnd(';'), 'User')
    if (@($env:Path -split ';') -notcontains $bin) { $env:Path = $bin + ';' + $env:Path }
  }
  Write-Output "Team Synergy CLI installed: $bin\tsp.cmd"
  Write-Output "Open a new terminal, then authorize this client: tsp auth login --api $BaseUrl"
} finally {
  $lock.Dispose()
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ne $InstallDir) { throw 'Unsafe stage cleanup.' }
  Assert-NoLinks $stage
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Remove-Item -LiteralPath $lockPath -Force
}
