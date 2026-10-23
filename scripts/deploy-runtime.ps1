[CmdletBinding()]
param([string]$RuntimeRoot = 'F:\workspace\team-synergy-runtime')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'sync-service.ps1'))) { throw 'Runtime sync script is missing.' }
if ([string]::IsNullOrWhiteSpace($env:TSP_DATABASE_URL)) { throw 'Set TSP_DATABASE_URL and matching PG connection environment.' }
$target = [Uri]$env:TSP_DATABASE_URL
$targetPort = if ($target.Port -gt 0) { [string]$target.Port } else { '5432' }
$targetUser = [Uri]::UnescapeDataString($target.UserInfo.Split(':',2)[0])
if ($env:PGHOST -ne $target.Host -or $env:PGPORT -ne $targetPort -or $env:PGDATABASE -ne $target.AbsolutePath.TrimStart('/') -or $env:PGUSER -ne $targetUser) {
  throw 'Backup PG environment must match the service database target.'
}
& (Join-Path $PSScriptRoot 'backup-database.ps1') -BackupDirectory (Join-Path $runtime 'backups')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $runtime 'sync-service.ps1') -Source $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Service deployment failed; follow docs/ops/runbook.md.' }
& node (Join-Path $runtime 'team-synergy-service\apps\core-api\dist\migrate.js')
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; stop deployment and follow docs/ops/runbook.md.' }
$env:TSP_AUTO_MIGRATE = 'false'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $runtime 'start-service.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Service startup failed; follow docs/ops/runbook.md.' }
foreach ($url in @('http://127.0.0.1:8080/ready','http://127.0.0.1:5173')) {
  if ((Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10).StatusCode -ne 200) { throw 'Deployment readiness failed.' }
}
