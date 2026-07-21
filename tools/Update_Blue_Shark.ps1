$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$app = Join-Path $root 'app'
$runtime = Join-Path $root 'runtime'
$nodeModules = Join-Path $app 'node_modules'
$backupRoot = Join-Path $root 'backup'

Write-Host 'Blue Shark Sender - Manual Update' -ForegroundColor Cyan
Write-Host 'This updates only whatsapp-web.js. Your QR session and sent PDFs are not touched.'
$answer = Read-Host 'Type YES to continue'
if ($answer -ne 'YES') { Write-Host 'Cancelled.'; exit 0 }

try {
  $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:32147/api/stop' -Headers @{'X-Blue-Shark-Token'=$config.token} -TimeoutSec 2 | Out-Null
  Start-Sleep -Seconds 2
} catch { }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath (Join-Path $app 'package.json') -Destination $backup
if (Test-Path -LiteralPath (Join-Path $app 'package-lock.json')) { Copy-Item -LiteralPath (Join-Path $app 'package-lock.json') -Destination $backup }
if (Test-Path -LiteralPath $nodeModules) { Move-Item -LiteralPath $nodeModules -Destination $backup }

try {
  $env:PATH = "$runtime;$env:PATH"
  $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
  $env:PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true'
  Push-Location $app
  & (Join-Path $runtime 'npm.cmd') install whatsapp-web.js@latest --save-exact --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }
  Pop-Location
  Write-Host "Update completed. Backup: $backup" -ForegroundColor Green
  Write-Host 'Run BlueSharkSender.exe and test the connection. Use Rollback_Update.cmd if needed.'
} catch {
  if ((Get-Location).Path -eq $app) { Pop-Location }
  $resolvedApp = [System.IO.Path]::GetFullPath($app)
  $resolvedRoot = [System.IO.Path]::GetFullPath($root)
  if (-not $resolvedApp.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe application path.' }
  if (Test-Path -LiteralPath $nodeModules) { Remove-Item -LiteralPath $nodeModules -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $backup 'node_modules') -Destination $app
  Copy-Item -LiteralPath (Join-Path $backup 'package.json') -Destination (Join-Path $app 'package.json') -Force
  if (Test-Path -LiteralPath (Join-Path $backup 'package-lock.json')) { Copy-Item -LiteralPath (Join-Path $backup 'package-lock.json') -Destination (Join-Path $app 'package-lock.json') -Force }
  Write-Host "Update failed and the previous version was restored: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Read-Host 'Press Enter to close'
