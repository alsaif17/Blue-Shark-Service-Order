[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
if (-not $env:BLUE_SHARK_BACKUP_PASSPHRASE -or $env:BLUE_SHARK_BACKUP_PASSPHRASE.Length -lt 20) {
  throw 'Set BLUE_SHARK_BACKUP_PASSPHRASE to at least 20 characters.'
}
foreach ($command in @('pg_dump','rclone','tar')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command is missing: $command" }
}
foreach ($name in @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','BLUE_SHARK_STORAGE_S3_ENDPOINT','BLUE_SHARK_STORAGE_S3_ACCESS_KEY','BLUE_SHARK_STORAGE_S3_SECRET_KEY')) {
  if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value) { throw "Required environment variable is missing: $name" }
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('BlueSharkBackup-' + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $temporaryRoot 'payload'
$archive = Join-Path $temporaryRoot 'backup.tar'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $destination "BlueShark-$timestamp.bsbak"
try {
  foreach ($bucket in @('order-documents','app-updates')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $payload "storage\$bucket") | Out-Null
  }
  & pg_dump --format=custom --no-owner --no-acl --file (Join-Path $payload 'database.dump')
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }

  $env:RCLONE_CONFIG_BS_TYPE = 's3'
  $env:RCLONE_CONFIG_BS_PROVIDER = 'Other'
  $env:RCLONE_CONFIG_BS_ENDPOINT = $env:BLUE_SHARK_STORAGE_S3_ENDPOINT
  $env:RCLONE_CONFIG_BS_ACCESS_KEY_ID = $env:BLUE_SHARK_STORAGE_S3_ACCESS_KEY
  $env:RCLONE_CONFIG_BS_SECRET_ACCESS_KEY = $env:BLUE_SHARK_STORAGE_S3_SECRET_KEY
  $env:RCLONE_CONFIG_BS_NO_CHECK_BUCKET = 'true'
  foreach ($bucket in @('order-documents','app-updates')) {
    & rclone copy "bs:$bucket" (Join-Path $payload "storage\$bucket") --checksum --metadata
    if ($LASTEXITCODE -ne 0) { throw "Storage backup failed: $bucket" }
  }

  $entries = Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object {
    [ordered]@{
      path = [IO.Path]::GetRelativePath($payload, $_.FullName).Replace('\','/')
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $manifest = [ordered]@{ schemaVersion=1; createdAt=(Get-Date).ToUniversalTime().ToString('o'); entries=@($entries) }
  [IO.File]::WriteAllText((Join-Path $payload 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  & tar -cf $archive -C $payload .
  if ($LASTEXITCODE -ne 0) { throw 'Backup archive creation failed' }

  $node = if (Test-Path (Join-Path $PSScriptRoot '..\runtime\node.exe')) { Join-Path $PSScriptRoot '..\runtime\node.exe' } else { (Get-Command node).Source }
  & $node (Join-Path $PSScriptRoot '..\tools\Backup_Cipher.js') encrypt $archive $output
  if ($LASTEXITCODE -ne 0) { throw 'Backup encryption failed' }
  Write-Host "Encrypted backup created: $output"
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
