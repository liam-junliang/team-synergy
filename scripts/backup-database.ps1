[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupDirectory,
  [ValidateRange(1,365)][int]$Keep = 7
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Use PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from the secured environment.
# Connection secrets never appear in process arguments or output.
if ([string]::IsNullOrWhiteSpace($env:PGDATABASE)) { throw 'Set PGDATABASE and PostgreSQL connection environment before backup.' }
$backupRoot = [IO.Path]::GetFullPath($BackupDirectory)
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$file = Join-Path $backupRoot ('team-synergy-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.dump')
$partial = $file + '.partial'
& pg_dump --format=custom --no-password --file $partial
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed; deployment must stop.' }
& pg_restore --list $partial | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Archive validation failed; deployment must stop.' }
Move-Item -LiteralPath $partial -Destination $file
# Limit retention to this script's dated archives directly in the verified directory.
Get-ChildItem -LiteralPath $backupRoot -File -Filter 'team-synergy-*.dump' |
  Where-Object { $_.Name -match '^team-synergy-\d{8}-\d{6}-\d{3}\.dump$' } |
  Sort-Object Name -Descending | Select-Object -Skip $Keep |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName }
Write-Output $file
