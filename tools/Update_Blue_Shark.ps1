param(
  [ValidateSet('Check','Manual')][string]$Mode = 'Manual',
  [string]$CurrentVersion = '0.0.0',
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = Join-Path $root 'runtime\node.exe'
$client = Join-Path $root 'tools\Check_Signed_Update.js'
$programDataRoot = Join-Path $env:ProgramData 'BlueShark'
$incoming = Join-Path $programDataRoot 'Incoming'
$logDirectory = Join-Path $programDataRoot 'Logs'
$dataRoot = if ($env:BLUE_SHARK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:BLUE_SHARK_DATA_DIR)
} elseif ($root.StartsWith([Environment]::GetFolderPath('ProgramFiles'), [StringComparison]::OrdinalIgnoreCase)) {
  Join-Path $env:LOCALAPPDATA 'BlueShark\data'
} else {
  Join-Path $root 'data'
}

function Write-UpdateLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  Add-Content -LiteralPath (Join-Path $logDirectory 'update.log') -Value ((Get-Date).ToString('s') + ' ' + $Message) -Encoding UTF8
}

try {
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $client -PathType Leaf)) {
    throw 'Signed update client is missing.'
  }
  if ($Mode -eq 'Manual') {
    $answer = Read-Host 'Check the private signed update channel and install an available release? Type YES'
    if ($answer -ne 'YES') { exit 0 }
  }

  New-Item -ItemType Directory -Force -Path $incoming | Out-Null
  & $node $client --app-root $root --data-root $dataRoot --incoming $incoming
  $result = $LASTEXITCODE
  if ($result -eq 0) {
    Write-UpdateLog "no_update current=$CurrentVersion"
    exit 0
  }
  if ($result -ne 10) {
    throw "Signed update check failed with exit code $result."
  }

  if ($Mode -eq 'Manual') {
    try {
      $config = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/config' -TimeoutSec 2
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/api/status' -TimeoutSec 2
      if ($status.busy) { throw 'The application is busy. Wait for the current operation to finish.' }
      Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:32147/api/stop' -Headers @{'X-Blue-Shark-Token'=$config.token} -TimeoutSec 3 | Out-Null
    } catch {
      if ($_.Exception.Message -like '*busy*') { throw }
    }
  }

  $taskName = 'BlueShark Update Agent'
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw 'The protected update agent is not installed. Run tools\Install_Update_Agent.ps1 once as administrator.'
  }
  Start-ScheduledTask -TaskName $taskName
  Write-UpdateLog 'signed_update_staged task_started=true'
  exit 10
} catch {
  Write-UpdateLog "signed_update_failed reason=$($_.Exception.Message)"
  if ($Mode -eq 'Manual') {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
  }
  exit 2
}
