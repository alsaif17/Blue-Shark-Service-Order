$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRoot = Join-Path $root 'backup'
$latest = Get-ChildItem -LiteralPath $backupRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) { Write-Host 'No application update backup was found.' -ForegroundColor Yellow; Read-Host 'Press Enter to close'; exit 1 }

Write-Host "Restore $($latest.Name)? Customer data and WhatsApp session will not be changed." -ForegroundColor Cyan
if ((Read-Host 'Type YES to continue') -ne 'YES') { exit 0 }

try {
  $status = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/status' -TimeoutSec 2
  if ($status.busy) { throw 'The application is busy. Wait for the current send/restore operation to finish.' }
  $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:32147/api/stop' -Headers @{'X-Blue-Shark-Token'=$config.token} -TimeoutSec 2 | Out-Null
  Start-Sleep -Seconds 3
} catch {
  if ($_.Exception.Message -like '*busy*') { throw }
}

$items = @('app','runtime','licenses','tools','BlueSharkSender.exe','README_AR.txt','THIRD_PARTY_NOTICES.txt','version.json')
$failed = Join-Path $backupRoot ("failed-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $failed | Out-Null
foreach ($item in $items) {
  $current = Join-Path $root $item
  if (Test-Path -LiteralPath $current) { Move-Item -LiteralPath $current -Destination $failed -Force }
  $saved = Join-Path $latest.FullName $item
  if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $root -Force }
}
Write-Host 'Rollback completed. Start BlueSharkSender.exe.' -ForegroundColor Green
Read-Host 'Press Enter to close'
