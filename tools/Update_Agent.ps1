param(
  [string]$InstallRoot = "$env:ProgramFiles\BlueShark"
)

$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$programFiles = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ProgramFiles')).TrimEnd('\') + '\'
if (-not $InstallRoot.StartsWith($programFiles, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The update agent only accepts an installation below Program Files.'
}

$stateRoot = Join-Path $env:ProgramData 'BlueShark'
$incoming = Join-Path $stateRoot 'Incoming'
$backupRoot = Join-Path $stateRoot 'Backups'
$packageArchive = Join-Path $stateRoot 'Packages'
$logDirectory = Join-Path $stateRoot 'Logs'
$node = Join-Path $InstallRoot 'runtime\node.exe'
$verifier = Join-Path $InstallRoot 'tools\Verify_Signed_Package.js'
$trustVerifier = Join-Path $InstallRoot 'tools\Verify_Trust_Bundle.js'
$items = @('app','runtime','licenses','tools','BlueSharkSender.exe','README_AR.txt','THIRD_PARTY_NOTICES.txt','version.json')

function Write-AgentLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  Add-Content -LiteralPath (Join-Path $logDirectory 'update-agent.log') -Value ((Get-Date).ToString('s') + ' ' + $Message) -Encoding UTF8
}

function Assert-Child([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path: $full" }
  return $full
}

if (-not (Test-Path -LiteralPath (Join-Path $incoming 'ready.json') -PathType Leaf)) { exit 0 }
$staging = Assert-Child (Join-Path $stateRoot ('Staging\' + [guid]::NewGuid().ToString('N'))) $stateRoot
$backup = $null
$trustChanged = $false
try {
  & $node $verifier $InstallRoot $incoming
  if ($LASTEXITCODE -ne 0) { throw 'Signed package verification failed.' }
  $manifest = Get-Content -LiteralPath (Join-Path $incoming 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $sequence = [long]$manifest.release_sequence
  $backup = Assert-Child (Join-Path $backupRoot ("app-$sequence-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))) $backupRoot

  $running = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $running = Get-CimInstance Win32_Process -Filter "Name='BlueSharkSender.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).Equals((Join-Path $InstallRoot 'BlueSharkSender.exe'), [StringComparison]::OrdinalIgnoreCase) }
    if (-not $running) { break }
    Start-Sleep -Seconds 1
  }
  if ($running) { throw 'The application did not exit before the protected update.' }

  New-Item -ItemType Directory -Force -Path $staging,$backup,$packageArchive | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $incoming 'package.zip'
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($entry in $archive.Entries) {
      $target = [IO.Path]::GetFullPath((Join-Path $staging $entry.FullName))
      $prefix = [IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
      if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe archive entry: $($entry.FullName)" }
    }
  } finally { $archive.Dispose() }
  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
  $packageRoot = Join-Path $staging 'Blue_Shark_WhatsApp_Sender_Portable'
  $packageVersion = Get-Content -LiteralPath (Join-Path $packageRoot 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([long]$packageVersion.releaseSequence -ne $sequence -or [string]$packageVersion.version -ne [string]$manifest.version) {
    throw 'Package version metadata does not match the signed manifest.'
  }

  $packageTrust = Join-Path $packageRoot 'config\trusted-keys.json'
  if (Test-Path -LiteralPath $packageTrust -PathType Leaf) {
    $installedRootKey = Join-Path $InstallRoot 'config\update-root-public-key.pem'
    $installedTrust = Join-Path $InstallRoot 'config\trusted-keys.json'
    $trustVerifierReady = Test-Path -LiteralPath $trustVerifier -PathType Leaf
    $rootKeyReady = Test-Path -LiteralPath $installedRootKey -PathType Leaf
    $installedTrustReady = Test-Path -LiteralPath $installedTrust -PathType Leaf
    if (-not $trustVerifierReady -or -not $rootKeyReady -or -not $installedTrustReady) {
      throw 'Installed update trust material is incomplete.'
    }
    & $node $trustVerifier $installedRootKey $packageTrust
    if ($LASTEXITCODE -ne 0) { throw 'The package trust bundle is not signed by the installed root.' }
    $savedTrustDirectory = Join-Path $backup 'config'
    New-Item -ItemType Directory -Force -Path $savedTrustDirectory | Out-Null
    Move-Item -LiteralPath $installedTrust -Destination (Join-Path $savedTrustDirectory 'trusted-keys.json') -Force
    $trustChanged = $true
    Copy-Item -LiteralPath $packageTrust -Destination $installedTrust -Force
  }

  foreach ($item in $items) {
    $existing = Join-Path $InstallRoot $item
    if (Test-Path -LiteralPath $existing) { Move-Item -LiteralPath $existing -Destination $backup -Force }
  }
  foreach ($item in $items) {
    $source = Join-Path $packageRoot $item
    if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $InstallRoot -Force }
  }

  $healthRoot = Join-Path $stateRoot 'Health'
  New-Item -ItemType Directory -Force -Path $healthRoot | Out-Null
  $env:BLUE_SHARK_DATA_DIR = $healthRoot
  $env:BLUE_SHARK_DISABLE_WHATSAPP = '1'
  $env:BLUE_SHARK_NO_OPEN_BROWSER = '1'
  $env:BLUE_SHARK_SKIP_UPDATE = '1'
  $env:BLUE_SHARK_PORT = '32148'
  $health = Start-Process -FilePath (Join-Path $InstallRoot 'runtime\node.exe') -ArgumentList @((Join-Path $InstallRoot 'app\server.js')) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32148/api/config' -TimeoutSec 2
      if ($config.appId -eq 'blue-shark-sender' -and $config.appVersion -eq [string]$manifest.version) { $healthy = $true; break }
    } catch {}
  }
  if (-not $health.HasExited) { Stop-Process -Id $health.Id -Force -ErrorAction SilentlyContinue }
  if (-not $healthy) { throw 'The installed release failed its isolated health check.' }

  Copy-Item -LiteralPath $zip -Destination (Join-Path $packageArchive ("package-$sequence.zip")) -Force
  Get-ChildItem -LiteralPath $packageArchive -Filter 'package-*.zip' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 2 |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  Remove-Item -LiteralPath (Join-Path $incoming 'ready.json') -Force
  Remove-Item -LiteralPath (Join-Path $incoming 'manifest.json') -Force
  Remove-Item -LiteralPath $zip -Force
  Write-AgentLog "update_applied sequence=$sequence version=$($manifest.version) backup=$backup"
} catch {
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    foreach ($item in $items) {
      $broken = Join-Path $InstallRoot $item
      if (Test-Path -LiteralPath $broken) { Remove-Item -LiteralPath $broken -Recurse -Force }
      $saved = Join-Path $backup $item
      if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $InstallRoot -Force }
    }
    if ($trustChanged) {
      $installedTrust = Join-Path $InstallRoot 'config\trusted-keys.json'
      $savedTrust = Join-Path $backup 'config\trusted-keys.json'
      if (Test-Path -LiteralPath $installedTrust) { Remove-Item -LiteralPath $installedTrust -Force }
      if (Test-Path -LiteralPath $savedTrust) { Move-Item -LiteralPath $savedTrust -Destination $installedTrust -Force }
    }
  }
  Write-AgentLog "update_rollback reason=$($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
