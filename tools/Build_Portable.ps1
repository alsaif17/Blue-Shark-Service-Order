param(
    [ValidateRange(0, [long]::MaxValue)][long]$ReleaseSequence = 0,
    [ValidateSet('pilot', 'stable')][string]$UpdateChannel = 'stable'
)

$ErrorActionPreference = 'Stop'

Set-StrictMode -Version 2.0

$packageName = 'Blue_Shark_WhatsApp_Sender_Portable'
$knownWebCacheFile = '2.3000.1043280533.html'

$toolsRoot = Split-Path -Parent $PSCommandPath
$sourceRoot = Split-Path -Parent $toolsRoot
$workspaceRoot = $sourceRoot
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("BlueSharkPortableBuild-$PID")
$stagingRoot = Join-Path $buildRoot $packageName
$releaseRoot = Join-Path $workspaceRoot 'release'
$zipOutput = Join-Path $releaseRoot ($packageName + '.zip')
$hashOutput = Join-Path $releaseRoot 'SHA256SUMS.txt'
$zipTemporary = Join-Path $buildRoot ($packageName + '.zip.tmp')
$hashTemporary = Join-Path $buildRoot 'SHA256SUMS.txt.tmp'

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
}

function Assert-PathInsideWorkspace {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Workspace
    )

    $fullPath = Get-NormalizedFullPath $Path
    $fullWorkspace = Get-NormalizedFullPath $Workspace
    $prefix = $fullWorkspace + [System.IO.Path]::DirectorySeparatorChar

    if (-not $fullPath.Equals($fullWorkspace, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside workspace: $fullPath"
    }

    return $fullPath
}

function Remove-SafePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$AllowedRoot = $workspaceRoot
    )

    $safePath = Assert-PathInsideWorkspace -Path $Path -Workspace $AllowedRoot
    if (Test-Path -LiteralPath $safePath) {
        Remove-Item -LiteralPath $safePath -Recurse -Force
    }
}

function Copy-RequiredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $source = Join-Path $sourceRoot $Name
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Required directory is missing: $source"
    }

    $destination = Join-Path $DestinationRoot $Name
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    }
}

function Get-StagingRelativePath {
    param([Parameter(Mandatory = $true)][string]$FullPath)

    $prefix = (Get-NormalizedFullPath $stagingRoot) + [System.IO.Path]::DirectorySeparatorChar
    $normalized = [System.IO.Path]::GetFullPath($FullPath)
    if (-not $normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is not inside staging: $normalized"
    }

    return $normalized.Substring($prefix.Length).Replace('\', '/')
}

function Assert-CleanStaging {
    $allFiles = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force -File)
    $forbidden = New-Object System.Collections.Generic.List[string]

    foreach ($file in $allFiles) {
        $relative = Get-StagingRelativePath $file.FullName
        $name = $file.Name

        if ($name -match '(?i)\.(pdf|log|db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm)$' -or
            $name -match '(?i)^sent-orders\.json$' -or
            $name -match '(?i)^\.permissions' -or
            $relative -match '(?i)(^|/)(\.wwebjs_auth|session-blue-shark|user[ _-]?data)(/|$)') {
            $forbidden.Add($relative)
        }
    }

    $runtimeDataRoots = @(
        (Join-Path $stagingRoot 'data\session'),
        (Join-Path $stagingRoot 'data\temp'),
        (Join-Path $stagingRoot 'data\logs'),
        (Join-Path $stagingRoot 'Sent Orders')
    )
    foreach ($runtimeDataRoot in $runtimeDataRoots) {
        $unexpected = @(Get-ChildItem -LiteralPath $runtimeDataRoot -Recurse -Force -File)
        foreach ($file in $unexpected) {
            $forbidden.Add((Get-StagingRelativePath $file.FullName))
        }
    }

    $cacheRoot = Join-Path $stagingRoot 'app\.wwebjs_cache'
    $cacheFiles = @(Get-ChildItem -LiteralPath $cacheRoot -Recurse -Force -File)
    if ($cacheFiles.Count -ne 1 -or $cacheFiles[0].Name -cne $knownWebCacheFile -or
        (Get-StagingRelativePath $cacheFiles[0].FullName) -cne ('app/.wwebjs_cache/' + $knownWebCacheFile)) {
        $forbidden.Add('app/.wwebjs_cache must contain only ' + $knownWebCacheFile)
    }

    if ($forbidden.Count -gt 0) {
        $details = ($forbidden | Select-Object -Unique | Select-Object -First 25) -join [Environment]::NewLine
        throw "Forbidden runtime or customer data found in staging:$([Environment]::NewLine)$details"
    }
}

function New-DeterministicZip {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$DestinationZip
    )

    Add-Type -AssemblyName System.IO.Compression

    $sourceFull = Get-NormalizedFullPath $SourceDirectory
    $archiveBase = Split-Path -Parent $sourceFull
    $archivePrefix = (Get-NormalizedFullPath $archiveBase) + [System.IO.Path]::DirectorySeparatorChar
    $fixedTimestamp = [System.DateTimeOffset]::ParseExact(
        '2000-01-01T00:00:00+00:00',
        'yyyy-MM-ddTHH:mm:sszzz',
        [System.Globalization.CultureInfo]::InvariantCulture
    )

    $directoryPaths = @($sourceFull)
    $directoryPaths += @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -Directory | ForEach-Object { $_.FullName })
    [Array]::Sort($directoryPaths, [System.StringComparer]::OrdinalIgnoreCase)

    $filePaths = @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File | ForEach-Object { $_.FullName })
    [Array]::Sort($filePaths, [System.StringComparer]::OrdinalIgnoreCase)

    $stream = [System.IO.File]::Open(
        $DestinationZip,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $archive = $null
    try {
        $archive = New-Object System.IO.Compression.ZipArchive -ArgumentList @(
            $stream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )

        foreach ($directoryPath in $directoryPaths) {
            $relative = [System.IO.Path]::GetFullPath($directoryPath).Substring($archivePrefix.Length).Replace('\', '/') + '/'
            $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::NoCompression)
            $entry.LastWriteTime = $fixedTimestamp
            $entry.ExternalAttributes = 16
        }

        foreach ($filePath in $filePaths) {
            $relative = [System.IO.Path]::GetFullPath($filePath).Substring($archivePrefix.Length).Replace('\', '/')
            $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $fixedTimestamp
            $entry.ExternalAttributes = 0

            $input = $null
            $output = $null
            try {
                $input = [System.IO.File]::Open(
                    $filePath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::Read
                )
                $output = $entry.Open()
                $input.CopyTo($output)
            }
            finally {
                if ($output) { $output.Dispose() }
                if ($input) { $input.Dispose() }
            }
        }
    }
    finally {
        if ($archive) { $archive.Dispose() }
        $stream.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Package source root is missing: $sourceRoot"
}

if ($ReleaseSequence -gt 0) {
    foreach ($relative in @('config\update-root-public-key.pem', 'config\trusted-keys.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative) -PathType Leaf)) {
            throw "Signed release build is missing deployment trust material: $relative"
        }
    }
}

$resolvedWorkspace = Get-NormalizedFullPath $workspaceRoot
$resolvedTemporary = Get-NormalizedFullPath ([IO.Path]::GetTempPath())
$resolvedSource = Assert-PathInsideWorkspace -Path $sourceRoot -Workspace $resolvedWorkspace
$resolvedBuild = Assert-PathInsideWorkspace -Path $buildRoot -Workspace $resolvedTemporary
$resolvedStaging = Assert-PathInsideWorkspace -Path $stagingRoot -Workspace $resolvedBuild
$resolvedZip = Assert-PathInsideWorkspace -Path $zipOutput -Workspace $resolvedWorkspace
$resolvedHash = Assert-PathInsideWorkspace -Path $hashOutput -Workspace $resolvedWorkspace

if ($resolvedStaging.Equals($resolvedSource, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Staging and source directories must be different.'
}

New-Item -ItemType Directory -Path $resolvedBuild -Force | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Remove-SafePath $resolvedStaging -AllowedRoot $resolvedBuild
Remove-SafePath $zipTemporary -AllowedRoot $resolvedBuild
Remove-SafePath $hashTemporary -AllowedRoot $resolvedBuild

try {
    New-Item -ItemType Directory -Path $resolvedStaging -Force | Out-Null

    foreach ($directory in @('app', 'runtime', 'licenses', 'tools', 'config')) {
        Copy-RequiredDirectory -Name $directory -DestinationRoot $resolvedStaging
    }
    $stagedCloudConfiguration = Join-Path $resolvedStaging 'config\cloud.json'
    if (Test-Path -LiteralPath $stagedCloudConfiguration) {
        Remove-Item -LiteralPath $stagedCloudConfiguration -Force
    }


    $launcher = Join-Path $sourceRoot 'BlueSharkSender.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Required launcher is missing: $launcher"
    }
    Copy-Item -LiteralPath $launcher -Destination $resolvedStaging -Force

    $rootDocuments = @(Get-ChildItem -LiteralPath $sourceRoot -Force -File | Where-Object {
        $_.Name -like 'README*' -or
        $_.Name -ceq 'version.json' -or
        $_.Extension -ieq '.cmd' -or
        $_.Name -match '(?i)(NOTICE|LICENSE)'
    })
    foreach ($document in $rootDocuments) {
        Copy-Item -LiteralPath $document.FullName -Destination $resolvedStaging -Force
    }

    $stagingCache = Join-Path $resolvedStaging 'app\.wwebjs_cache'
    Remove-SafePath $stagingCache -AllowedRoot $resolvedBuild
    New-Item -ItemType Directory -Path $stagingCache -Force | Out-Null

    $stagedVersionPath = Join-Path $resolvedStaging 'version.json'
    $stagedVersion = Get-Content -LiteralPath $stagedVersionPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stagedVersion.releaseSequence = $ReleaseSequence
    $stagedVersion.updateChannel = $UpdateChannel
    $stagedVersionJson = $stagedVersion | ConvertTo-Json -Depth 8
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($stagedVersionPath, $stagedVersionJson + [Environment]::NewLine, $utf8WithoutBom)

    $knownCacheSource = Join-Path $sourceRoot ('app\.wwebjs_cache\' + $knownWebCacheFile)
    if (-not (Test-Path -LiteralPath $knownCacheSource -PathType Leaf)) {
        throw "Known WhatsApp Web cache file is missing: $knownCacheSource"
    }
    Copy-Item -LiteralPath $knownCacheSource -Destination $stagingCache -Force

    foreach ($emptyDirectory in @('data\session', 'data\temp', 'data\logs', 'Sent Orders')) {
        New-Item -ItemType Directory -Path (Join-Path $resolvedStaging $emptyDirectory) -Force | Out-Null
    }

    Assert-CleanStaging
    New-DeterministicZip -SourceDirectory $resolvedStaging -DestinationZip $zipTemporary

    $zipHash = (Get-FileHash -LiteralPath $zipTemporary -Algorithm SHA256).Hash.ToUpperInvariant()
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $hashTemporary,
        ($zipHash + '  ' + $packageName + '.zip' + "`r`n"),
        $utf8WithoutBom
    )

    if (Test-Path -LiteralPath $resolvedZip) {
        Remove-Item -LiteralPath $resolvedZip -Force
    }
    if (Test-Path -LiteralPath $resolvedHash) {
        Remove-Item -LiteralPath $resolvedHash -Force
    }

    Move-Item -LiteralPath $zipTemporary -Destination $resolvedZip
    Move-Item -LiteralPath $hashTemporary -Destination $resolvedHash

    Write-Host "Built: $resolvedZip"
    Write-Host "SHA256: $zipHash"
    Write-Host "Checksums: $resolvedHash"
}
finally {
    Remove-SafePath $zipTemporary -AllowedRoot $resolvedBuild
    Remove-SafePath $hashTemporary -AllowedRoot $resolvedBuild
    Remove-SafePath $resolvedStaging -AllowedRoot $resolvedBuild
    Remove-SafePath $resolvedBuild -AllowedRoot $resolvedTemporary
}
