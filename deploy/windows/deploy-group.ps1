param(
    [Parameter(Mandatory = $true)][string]$PlatformRoot,
    [Parameter(Mandatory = $true)][string]$RuntimePackagePath,
    [Parameter(Mandatory = $true)][string]$SourceRevision,
    [string]$SlotName = '',
    [switch]$SkipConsoleRestart
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$package = [IO.Path]::GetFullPath($RuntimePackagePath)
$revision = $SourceRevision.Trim().ToLowerInvariant()
if ($revision -notmatch '^[a-f0-9]{7,40}$') { throw 'SourceRevision must be a Git hex revision.' }
if (!$SlotName) { $SlotName = 'synrex-windows-group-' + $revision.Substring(0, [Math]::Min(8, $revision.Length)) }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run deploy-group.ps1 from elevated PowerShell. Production has not been changed.'
}

$prepare = Join-Path $PSScriptRoot 'prepare-runtime-slot.ps1'
$service = Join-Path $PSScriptRoot 'group-service.ps1'
$console = Join-Path $PSScriptRoot 'install-console-desktop.ps1'
foreach ($required in @($prepare, $service, $console, $package)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Deployment input missing: $required" }
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $prepare -PlatformRoot $root -RuntimePackagePath $package -SlotName $SlotName -SourceRevision $revision
if ($LASTEXITCODE -ne 0) { throw 'Runtime slot preparation failed.' }

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $service -Action Activate -PlatformRoot $root -SlotName $SlotName
if ($LASTEXITCODE -ne 0) { throw 'Group activation failed.' }

if ($SkipConsoleRestart) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $console -PlatformRoot $root
} else {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $console -PlatformRoot $root -Restart
}
if ($LASTEXITCODE -ne 0) { throw 'Synrex Console installation failed.' }

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $service -Action Check -PlatformRoot $root
if ($LASTEXITCODE -ne 0) { throw 'Post-deployment Group readiness check failed.' }

$active = (Get-Content -Raw -LiteralPath (Join-Path $root 'runtime\active-slot.txt')).Trim()
if ($active -ne $SlotName) { throw "Active slot mismatch after deployment: $active" }

[PSCustomObject]@{
    status = 'ready'
    slot = $active
    revision = $revision
    console = 'http://127.0.0.1:17677/console'
    launcher = (Join-Path $root 'ops\start-synrex-console.ps1')
}
