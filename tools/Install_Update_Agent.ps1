param(
  [string]$InstallRoot = "$env:ProgramFiles\BlueShark"
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script once as administrator.'
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$programFiles = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ProgramFiles')).TrimEnd('\') + '\'
if (-not $InstallRoot.StartsWith($programFiles, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'InstallRoot must be below Program Files.'
}
$agent = Join-Path $InstallRoot 'tools\Update_Agent.ps1'
if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) { throw 'Update agent script is missing from the installation.' }

$stateRoot = Join-Path $env:ProgramData 'BlueShark'
$incoming = Join-Path $stateRoot 'Incoming'
New-Item -ItemType Directory -Force -Path $incoming,(Join-Path $stateRoot 'Backups'),(Join-Path $stateRoot 'Packages'),(Join-Path $stateRoot 'Logs') | Out-Null
& icacls.exe $InstallRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-32-545:(OI)(CI)(RX)' /T /C /Q | Out-Null
& icacls.exe $incoming /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-32-545:(OI)(CI)(M)' /T /C /Q | Out-Null

$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $agent + '" -InstallRoot "' + $InstallRoot + '"'
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -StartWhenAvailable
$principalTask = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'BlueShark Update Agent' -Action $action -Trigger $trigger -Settings $settings -Principal $principalTask -Force | Out-Null
Write-Host 'BlueShark Update Agent installed successfully.'
