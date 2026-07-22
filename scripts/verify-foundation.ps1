[CmdletBinding()]
param(
  [string]$RepositoryRoot = '',
  [string]$GitExecutable = '',
  [string]$NodeExecutable = '',
  [switch]$AllowLinkedProject,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path

function Resolve-Executable([string]$Explicit, [string]$Name) {
  if ($Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required executable is missing from PATH: $Name" }
  return $command.Source
}

$git = Resolve-Executable $GitExecutable 'git'
$node = Resolve-Executable $NodeExecutable 'node'
$required = @(
  'supabase/config.toml',
  'supabase/migrations/20260722081701_unified_service_orders_foundation.sql',
  'supabase/tests/authorization_and_numbering_test.sql',
  'supabase/functions/storage-broker/handler.ts',
  'supabase/functions/admin-users/handler.ts',
  'supabase/functions/update-check/handler.ts',
  'app/lib/secure-store.js',
  'app/lib/encrypted-user-store.js',
  'app/lib/cloud-runtime.js',
  'app/lib/update-signature.js',
  'config/migration-branch-map.example.json',
  'supabase/manual/bootstrap_first_admin.example.sql',
  'scripts/Prepare_Legacy_Migration.js',
  'scripts/Import_Legacy_Package.js',
  'scripts/Backup_Supabase.ps1',
  'scripts/Restore_Supabase.ps1',
  'tools/Backup_Cipher.js',
  'tools/Initialize_Signing_Keys.js',
  'tools/Manage_Trusted_Keys.js',
  'tools/New_Release_Manifest.js',
  'tools/Sign_Update_Manifest.js',
  'tools/Verify_Signed_Package.js',
  'tools/Verify_Trust_Bundle.js',
  'tools/Publish_Signed_Release.js',
  'tools/Check_Signed_Update.js',
  'tools/Install_Update_Agent.ps1',
  'tools/Build_Portable.ps1',
  'tools/Update_Agent.ps1',
  'docs/HANDOFF_CHECKLIST.md',
  'docs/MIGRATION_RUNBOOK.md',
  'docs/BACKUP_RESTORE_RUNBOOK.md',
  'docs/UPDATE_SIGNING_RUNBOOK.md',
  'docs/PRODUCTION_GATES.md',
  'docs/SUPABASE_FOUNDATION.md',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'config/cloud.example.json'
)

foreach ($relative in $required) {
  $full = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Missing foundation file: $relative"
  }
}

$config = Get-Content -LiteralPath (Join-Path $root 'supabase/config.toml') -Raw
if ($config -notmatch 'schemas\s*=\s*\["api"\]') { throw 'Only the api schema may be exposed' }
if ($config -notmatch '(?ms)^\[realtime\]\s*\r?\nenabled\s*=\s*false') { throw 'Realtime must remain disabled for version one' }
if ($config -notmatch 'jwt_expiry\s*=\s*900') { throw 'JWT expiry must remain 900 seconds' }
if ($config -notmatch 'enable_signup\s*=\s*false') { throw 'Self-signup must remain disabled' }
if ($config -notmatch 'site_url\s*=\s*"http://127\.0\.0\.1:32147"') { throw 'Auth site URL must match the loopback application endpoint' }
if ($config -notmatch 'additional_redirect_urls\s*=\s*\["http://127\.0\.0\.1:32147",\s*"http://localhost:32147"\]') { throw 'Auth redirects must remain loopback-only' }
if ($config -notmatch '(?ms)^\[functions\.update-check\].*?verify_jwt\s*=\s*false') { throw 'update-check must declare its pre-login auth mode' }
if ($config -notmatch '(?ms)^\[functions\.admin-users\].*?verify_jwt\s*=\s*true') { throw 'admin-users must require a user JWT' }
if ($config -notmatch '(?ms)^\[functions\.storage-broker\].*?verify_jwt\s*=\s*true') { throw 'storage-broker must require a user JWT' }

$linkMarker = Join-Path $root 'supabase\.temp\project-ref'
if ((Test-Path -LiteralPath $linkMarker) -and -not $AllowLinkedProject) {
  throw 'Repository is linked to a Supabase project; pass -AllowLinkedProject only in the controlled handoff environment'
}

$tracked = @(& $git -C $root ls-files)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
$forbiddenTrackedPatterns = @(
  '^config/cloud\.json$',
  '^config/trusted-keys\.json$',
  '^config/update-root-public-key\.pem$',
  '^config/release-manifest(?:\.signed)?\.json$',
  '(^|/)(?:root|release)-private-key\.pem$',
  '(^|/)signing-private/'
)
foreach ($relative in $tracked) {
  foreach ($pattern in $forbiddenTrackedPatterns) {
    if ($relative -match $pattern) { throw "Forbidden credential or deployment file is tracked: $relative" }
  }
}

$candidates = @(& $git -C $root ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'git repository file enumeration failed' }
$secretPatterns = @(
  'sb_secret_[A-Za-z0-9_-]{16,}',
  '-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----',
  'https://[a-z0-9]{20}\.supabase\.co'
)
foreach ($relative in $candidates) {
  if ($relative -notmatch '\.(?:js|ts|json|md|sql|ps1|toml|cs|iss|html)$' -and $relative -ne '.gitignore') { continue }
  $full = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $fileText = Get-Content -LiteralPath $full -Raw
  foreach ($pattern in $secretPatterns) {
    if ($fileText -match $pattern) { throw "Secret or real-project-shaped content exists in repository file: $relative" }
  }
}

$migration = Get-Content -LiteralPath (Join-Path $root 'supabase/migrations/20260722081701_unified_service_orders_foundation.sql') -Raw
if ($migration -notmatch '(?i)alter\s+default\s+privileges.*schema\s+api\s+revoke\s+execute') { throw 'API default execute privileges are not revoked' }
if ($migration -notmatch '(?i)force\s+row\s+level\s+security') { throw 'Forced RLS is missing' }
if ($migration -notmatch '(?i)revoke\s+all\s+on\s+schema\s+app\s+from\s+public') { throw 'Private app schema is not revoked from PUBLIC' }
$definerCount = [regex]::Matches($migration, '(?i)security\s+definer').Count
$pinnedDefinerCount = [regex]::Matches($migration, '(?i)security\s+definer\s*\r?\n\s*set\s+search_path\s*=\s*''''').Count
if ($definerCount -ne $pinnedDefinerCount) { throw 'Every privileged SQL function must pin an empty search_path' }

$updaterText = (Get-Content -LiteralPath (Join-Path $root 'tools/Update_Blue_Shark.ps1') -Raw) +
  [Environment]::NewLine + (Get-Content -LiteralPath (Join-Path $root 'tools/Check_Signed_Update.js') -Raw)
if ($updaterText -match '(?i)api\.github\.com|github\.com/[^\s]+/releases') {
  throw 'Public GitHub release fallback remains in the updater'
}
if ($updaterText -notmatch 'Verify_Signed_Package|verifyReleaseManifest') { throw 'Signed update verification is not wired' }

$updateAgentText = Get-Content -LiteralPath (Join-Path $root 'tools/Update_Agent.ps1') -Raw
$buildText = Get-Content -LiteralPath (Join-Path $root 'tools/Build_Portable.ps1') -Raw
if ($updateAgentText -notmatch 'Verify_Trust_Bundle\.js' -or $updateAgentText -notmatch 'installedRootKey' -or $updateAgentText -notmatch 'trustChanged') {
  throw 'Root-verified trust bundle rotation and rollback are not wired into the update agent'
}
if ($buildText -notmatch '\$ReleaseSequence\s+-gt\s+0' -or $buildText -notmatch 'update-root-public-key\.pem' -or $buildText -notmatch 'trusted-keys\.json') {
  throw 'Production release builds must require deployment trust material'
}

$sourceGuardIndex = $buildText.IndexOf('throw "Package source root is missing: $sourceRoot"')
$releaseGateIndex = $buildText.IndexOf('if ($ReleaseSequence -gt 0)')
if ($sourceGuardIndex -lt 0 -or $releaseGateIndex -lt $sourceGuardIndex) {
  throw 'Production trust gate is nested in or precedes the source-root existence guard'
}
$edgeText = (Get-Content -LiteralPath (Join-Path $root 'supabase/functions/storage-broker/handler.ts') -Raw) +
  [Environment]::NewLine + (Get-Content -LiteralPath (Join-Path $root 'supabase/functions/admin-users/handler.ts') -Raw)
if ($edgeText -match 'Deno\.env\.get\("SUPABASE_PUBLISHABLE_KEY"\)') {
  throw 'Obsolete singular publishable-key environment variable is used'
}

$workflowText = (Get-Content -LiteralPath (Join-Path $root '.github/workflows/ci.yml') -Raw) +
  [Environment]::NewLine + (Get-Content -LiteralPath (Join-Path $root '.github/workflows/release.yml') -Raw)
if ($workflowText -match '(?im)^\s*contents:\s*write\s*$|gh\s+release\s+create|actions/upload-artifact') {
  throw 'GitHub Actions must remain test-only and read-only'
}
if ($workflowText -match '(?i)uses:\s*[^@\s]+@(?![0-9a-f]{40}(?:\s|$))') {
  throw 'Every third-party GitHub Action must be pinned to a full commit SHA'
}

$javascript = @(
  (Join-Path $root 'app/server.js')
  Get-ChildItem -LiteralPath (Join-Path $root 'app/lib') -Recurse -File -Filter '*.js' | Select-Object -ExpandProperty FullName
  Get-ChildItem -LiteralPath (Join-Path $root 'app/tests') -Recurse -File -Filter '*.js' | Select-Object -ExpandProperty FullName
  Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Recurse -File -Filter '*.js' | Select-Object -ExpandProperty FullName
  Get-ChildItem -LiteralPath (Join-Path $root 'tools') -Recurse -File -Filter '*.js' | Select-Object -ExpandProperty FullName
)
foreach ($file in $javascript) {
  & $node --check $file
  if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $file" }
}

$powershell = @(
  Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Recurse -File -Filter '*.ps1' | Select-Object -ExpandProperty FullName
  Get-ChildItem -LiteralPath (Join-Path $root 'tools') -Recurse -File -Filter '*.ps1' | Select-Object -ExpandProperty FullName
)
foreach ($file in $powershell) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "PowerShell parse failed: $file :: $($errors[0].Message)" }
}

& $git -C $root diff --check
if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed' }
if (-not $SkipTests) {
  $testFiles = Get-ChildItem -LiteralPath (Join-Path $root 'app/tests') -File -Filter '*.test.js' |
    Select-Object -ExpandProperty FullName
  & $node --test $testFiles
  if ($LASTEXITCODE -ne 0) { throw 'Node test suite failed' }
}
Write-Host 'Blue Shark local foundation verification passed. No Supabase link or deployment was performed.'
