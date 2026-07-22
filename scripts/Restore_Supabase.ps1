[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [Parameter(Mandatory = $true)][switch]$IUnderstandThisRestoresIntoAnEmptyProject
)

$ErrorActionPreference = 'Stop'
if (-not $IUnderstandThisRestoresIntoAnEmptyProject) { throw 'Explicit empty-project confirmation is required.' }
$backup = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $env:BLUE_SHARK_BACKUP_PASSPHRASE -or $env:BLUE_SHARK_BACKUP_PASSPHRASE.Length -lt 20) {
  throw 'Set BLUE_SHARK_BACKUP_PASSPHRASE to at least 20 characters.'
}
foreach ($command in @('pg_restore','rclone','tar')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is missing: $command" }
}
foreach ($name in @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','BLUE_SHARK_STORAGE_S3_ENDPOINT','BLUE_SHARK_STORAGE_S3_ACCESS_KEY','BLUE_SHARK_STORAGE_S3_SECRET_KEY')) {
  if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value) { throw "Required environment variable is missing: $name" }
}
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('BlueSharkRestore-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temporaryRoot 'backup.tar'
$payload = Join-Path $temporaryRoot 'payload'
try {
  New-Item -ItemType Directory -Force -Path $payload | Out-Null
  $node = if (Test-Path (Join-Path $PSScriptRoot '..\runtime\node.exe')) { Join-Path $PSScriptRoot '..\runtime\node.exe' } else { (Get-Command node).Source }
  & $node (Join-Path $PSScriptRoot '..\tools\Backup_Cipher.js') decrypt $backup $archive
  if ($LASTEXITCODE -ne 0) { throw 'Backup decryption failed' }
  $entries = & tar -tf $archive
  if ($LASTEXITCODE -ne 0 -or @($entries | Where-Object { $_ -match '(^[\\/])|(^|[\\/])\.\.([\\/]|$)' }).Count) {
    throw 'Backup archive contains an unsafe path'
  }
  & tar -xf $archive -C $payload
  if ($LASTEXITCODE -ne 0) { throw 'Backup extraction failed' }

  $manifest = Get-Content -LiteralPath (Join-Path $payload 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($entry in $manifest.entries) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $payload $entry.path))
    if (-not $candidate.StartsWith([IO.Path]::GetFullPath($payload).TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe manifest path' }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "Backup manifest file is missing: $($entry.path)"
    }
    $actualFile = Get-Item -LiteralPath $candidate
    $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualFile.Length -ne [long]$entry.size -or $actualHash -ne [string]$entry.sha256) {
      throw "Backup manifest mismatch: $($entry.path)"
    }
  }

  & pg_restore --exit-on-error --no-owner --no-acl --dbname $env:PGDATABASE (Join-Path $payload 'database.dump')
  if ($LASTEXITCODE -ne 0) { throw 'Database restore failed' }
  $env:RCLONE_CONFIG_BS_TYPE = 's3'
  $env:RCLONE_CONFIG_BS_PROVIDER = 'Other'
  $env:RCLONE_CONFIG_BS_ENDPOINT = $env:BLUE_SHARK_STORAGE_S3_ENDPOINT
  $env:RCLONE_CONFIG_BS_ACCESS_KEY_ID = $env:BLUE_SHARK_STORAGE_S3_ACCESS_KEY
  $env:RCLONE_CONFIG_BS_SECRET_ACCESS_KEY = $env:BLUE_SHARK_STORAGE_S3_SECRET_KEY
  $env:RCLONE_CONFIG_BS_NO_CHECK_BUCKET = 'true'
  foreach ($bucket in @('order-documents','app-updates')) {
    & rclone copy (Join-Path $payload "storage\$bucket") "bs:$bucket" --checksum --metadata
    if ($LASTEXITCODE -ne 0) { throw "Storage restore failed: $bucket" }
  }
  Write-Host 'Restore completed. Run the acceptance queries before using the project.'
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
