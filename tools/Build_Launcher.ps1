$ErrorActionPreference = 'Stop'

$toolsRoot = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $toolsRoot
$source = Join-Path $toolsRoot 'BlueSharkSenderLauncher.cs'
$manifest = Join-Path $toolsRoot 'BlueSharkSenderLauncher.manifest'
$output = Join-Path $appRoot 'BlueSharkSender.exe'

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
    throw 'The Windows C# compiler was not found.'
}

& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /debug- `
    "/win32manifest:$manifest" "/out:$output" `
    /reference:System.dll /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) {
    throw "BlueSharkSender.exe build failed with exit code $LASTEXITCODE"
}

$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
Write-Host "Built: $output"
Write-Host "SHA256: $hash"
