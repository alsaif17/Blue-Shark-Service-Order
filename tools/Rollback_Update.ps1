$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$app = Join-Path $root 'app'
$backupRoot = Join-Path $root 'backup'
$latest = Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) { Write-Host 'No update backup was found.' -ForegroundColor Yellow; Read-Host 'Press Enter to close'; exit 1 }

Write-Host "Rollback to $($latest.Name)?" -ForegroundColor Cyan
if ((Read-Host 'Type YES to continue') -ne 'YES') { exit 0 }

try {
  $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:32147/api/stop' -Headers @{'X-Blue-Shark-Token'=$config.token} -TimeoutSec 2 | Out-Null
  Start-Sleep -Seconds 2
} catch { }

$nodeModules = Join-Path $app 'node_modules'
$resolvedApp = [System.IO.Path]::GetFullPath($app)
if (-not $resolvedApp.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe application path.' }
if (Test-Path -LiteralPath $nodeModules) { Remove-Item -LiteralPath $nodeModules -Recurse -Force }
Move-Item -LiteralPath (Join-Path $latest.FullName 'node_modules') -Destination $app
Copy-Item -LiteralPath (Join-Path $latest.FullName 'package.json') -Destination (Join-Path $app 'package.json') -Force
if (Test-Path -LiteralPath (Join-Path $latest.FullName 'package-lock.json')) { Copy-Item -LiteralPath (Join-Path $latest.FullName 'package-lock.json') -Destination (Join-Path $app 'package-lock.json') -Force }
Write-Host 'Rollback completed.' -ForegroundColor Green
Read-Host 'Press Enter to close'
