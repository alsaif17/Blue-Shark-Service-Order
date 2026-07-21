param(
  [ValidateSet('Check','Apply','Manual')][string]$Mode = 'Manual',
  [string]$CurrentVersion = '0.0.0',
  [string]$StagingPath,
  [string]$InstallRoot,
  [int]$ParentPid = 0,
  [string]$TargetVersion
)

$ErrorActionPreference = 'Stop'
$repo = 'alsaif17/Blue-Shark-Service-Order'
$assetName = 'Blue_Shark_WhatsApp_Sender_Portable.zip'
$api = "https://api.github.com/repos/$repo/releases/latest"

function Write-UpdateLog([string]$Message) {
  $root = if ($InstallRoot) { $InstallRoot } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
  $logDir = Join-Path $root 'data\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -LiteralPath (Join-Path $logDir 'update.log') -Value ((Get-Date).ToString('s') + ' ' + $Message) -Encoding UTF8
}

function Test-ChildPath([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path: $full" }
  return $full
}

if ($Mode -eq 'Apply') {
  if (-not $InstallRoot -or -not $StagingPath -or -not $TargetVersion) { throw 'Apply parameters are incomplete.' }
  $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
  $StagingPath = [IO.Path]::GetFullPath($StagingPath)
  if ($ParentPid -gt 0) { try { Wait-Process -Id $ParentPid -Timeout 60 -ErrorAction SilentlyContinue } catch {} }
  $backup = Test-ChildPath (Join-Path $InstallRoot ("backup\app-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))) $InstallRoot
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  $items = @('app','runtime','licenses','tools','BlueSharkSender.exe','README_AR.txt','THIRD_PARTY_NOTICES.txt','version.json')
  $newProcess = $null
  try {
    foreach ($item in $items) {
      $existing = Join-Path $InstallRoot $item
      if (Test-Path -LiteralPath $existing) { Move-Item -LiteralPath $existing -Destination $backup -Force }
    }
    foreach ($item in $items) {
      $incoming = Join-Path $StagingPath $item
      if (Test-Path -LiteralPath $incoming) { Move-Item -LiteralPath $incoming -Destination $InstallRoot -Force }
    }
    if (-not (Test-Path (Join-Path $InstallRoot 'BlueSharkSender.exe')) -or -not (Test-Path (Join-Path $InstallRoot 'app\server.js'))) { throw 'Updated package is incomplete.' }
    $env:BLUE_SHARK_SKIP_UPDATE = '1'
    $newProcess = Start-Process -FilePath (Join-Path $InstallRoot 'BlueSharkSender.exe') -WorkingDirectory $InstallRoot -PassThru
    $healthy = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      Start-Sleep -Seconds 2
      try {
        $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
        if ($config.appId -eq 'blue-shark-sender' -and $config.appVersion -eq $TargetVersion) { $healthy = $true; break }
      } catch {}
    }
    if (-not $healthy) { throw 'The new version did not pass its startup health check.' }
    Write-UpdateLog "update_applied version=$TargetVersion backup=$backup"
  } catch {
    if ($newProcess -and -not $newProcess.HasExited) { & taskkill.exe /PID $newProcess.Id /T /F 2>$null | Out-Null; Start-Sleep -Seconds 2 }
    foreach ($item in $items) {
      $broken = Join-Path $InstallRoot $item
      if (Test-Path -LiteralPath $broken) { Remove-Item -LiteralPath $broken -Recurse -Force }
      $saved = Join-Path $backup $item
      if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $InstallRoot -Force }
    }
    Write-UpdateLog "update_rollback reason=$($_.Exception.Message)"
    $env:BLUE_SHARK_SKIP_UPDATE = '1'
    Start-Process -FilePath (Join-Path $InstallRoot 'BlueSharkSender.exe') -WorkingDirectory $InstallRoot
    exit 1
  } finally {
    Remove-Item -LiteralPath (Split-Path -Parent $StagingPath) -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
  $headers = @{ 'User-Agent' = 'Blue-Shark-Sender-Updater'; 'Accept' = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 20
  $latest = [string]$release.tag_name -replace '^[vV]', ''
  if ([version]$latest -le [version]$CurrentVersion) { Write-UpdateLog "no_update current=$CurrentVersion latest=$latest"; exit 0 }
  if ($Mode -eq 'Manual') {
    $answer = Read-Host "Version $latest is available. Type YES to install"
    if ($answer -ne 'YES') { exit 0 }
  }
  $zipAsset = @($release.assets | Where-Object name -eq $assetName)[0]
  $sumAsset = @($release.assets | Where-Object name -eq 'SHA256SUMS.txt')[0]
  if (-not $zipAsset -or -not $sumAsset) { throw 'Release assets are incomplete.' }
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("BlueSharkUpdate-" + [guid]::NewGuid().ToString('N'))
  $staging = Join-Path $temp 'package'
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $zip = Join-Path $temp $assetName
  $sums = Join-Path $temp 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri $zipAsset.browser_download_url -Headers $headers -OutFile $zip -TimeoutSec 300
  Invoke-WebRequest -Uri $sumAsset.browser_download_url -Headers $headers -OutFile $sums -TimeoutSec 30
  $expected = ((Get-Content -LiteralPath $sums -Raw) -split '\s+')[0].ToUpperInvariant()
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($expected -ne $actual) { throw 'SHA256 verification failed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($entry in $archive.Entries) {
      $target = [IO.Path]::GetFullPath((Join-Path $staging $entry.FullName))
      $stagingPrefix = [IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
      if (-not $target.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe archive entry: $($entry.FullName)" }
    }
  } finally { $archive.Dispose() }
  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
  $packageRoot = Join-Path $staging 'Blue_Shark_WhatsApp_Sender_Portable'
  if (-not (Test-Path (Join-Path $packageRoot 'BlueSharkSender.exe')) -or -not (Test-Path (Join-Path $packageRoot 'app\server.js'))) { throw 'Downloaded package is incomplete.' }
  $helper = Join-Path $temp 'Apply_Update.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $helper -Force
  $waitPid = if ($ParentPid -gt 0) { $ParentPid } else { 0 }
  if ($Mode -eq 'Manual') {
    try {
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/status' -TimeoutSec 2
      if ($status.busy) { throw 'The application is busy. Wait for the current operation to finish.' }
      $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
      $launcher = Get-CimInstance Win32_Process -Filter "Name='BlueSharkSender.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
      if ($launcher) { $waitPid = [int]$launcher.ProcessId }
      Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:32147/api/stop' -Headers @{'X-Blue-Shark-Token'=$config.token} -TimeoutSec 3 | Out-Null
    } catch {
      if ($_.Exception.Message -like '*busy*') { throw }
    }
  }
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $helper + '"'),'-Mode','Apply','-InstallRoot',('"' + $root + '"'),'-StagingPath',('"' + $packageRoot + '"'),'-ParentPid',$waitPid,'-TargetVersion',$latest) -join ' '
  Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden
  Write-UpdateLog "update_staged current=$CurrentVersion target=$latest"
  exit 10
} catch {
  Write-UpdateLog "update_check_failed reason=$($_.Exception.Message)"
  if ($Mode -eq 'Manual') { Write-Host $_.Exception.Message -ForegroundColor Red; Read-Host 'Press Enter to close' }
  exit 2
}
