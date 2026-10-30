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
$installedDeploymentRoot = Join-Path $root 'ops\deployment'
foreach ($required in @($prepare, $service, $console, $package, (Join-Path $PSScriptRoot 'start-group-stack.vbs'), (Join-Path $PSScriptRoot 'start-group-tray.vbs'), (Join-Path $PSScriptRoot 'start-group-stack.ps1'))) {
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

# Keep a self-contained copy of the Windows deployment toolkit beside the
# installed supervisor so future promotions do not depend on a source checkout.
$sourceDeploymentRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$targetDeploymentRoot = [IO.Path]::GetFullPath($installedDeploymentRoot).TrimEnd('\')
if (!$sourceDeploymentRoot.Equals($targetDeploymentRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $staging = $targetDeploymentRoot + '.staging'
    $previous = $targetDeploymentRoot + '.previous'
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Copy-Item -Path (Join-Path $sourceDeploymentRoot '*') -Destination $staging -Recurse -Force
    $movedPrevious = $false
    try {
        if (Test-Path -LiteralPath $targetDeploymentRoot -PathType Container) {
            Move-Item -LiteralPath $targetDeploymentRoot -Destination $previous
            $movedPrevious = $true
        }
        Move-Item -LiteralPath $staging -Destination $targetDeploymentRoot
        Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
    }
    catch {
        $installFailure = $_
        Remove-Item -LiteralPath $targetDeploymentRoot -Recurse -Force -ErrorAction SilentlyContinue
        if ($movedPrevious -and (Test-Path -LiteralPath $previous -PathType Container)) {
            Move-Item -LiteralPath $previous -Destination $targetDeploymentRoot
        }
        throw $installFailure
    }
}

$manualLauncher = Join-Path $installedDeploymentRoot 'start-group-stack.vbs'
if (!(Test-Path -LiteralPath $manualLauncher -PathType Leaf)) { throw "Manual Group launcher was not installed: $manualLauncher" }
$manualShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Synrex Group Start.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($manualShortcut)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$link.Arguments = '"' + $manualLauncher + '" "' + $root + '"'
$link.WorkingDirectory = $root
$consoleExe = Join-Path $root 'desktop\SynrexConsole.exe'
if (Test-Path -LiteralPath $consoleExe -PathType Leaf) { $link.IconLocation = $consoleExe + ',0' }
$link.Description = 'Cleanly restart the owned Synrex Group stack and open Console'
$link.Save()

[PSCustomObject]@{
    status = 'ready'
    slot = $active
    revision = $revision
    console = 'http://127.0.0.1:17677/console'
    launcher = (Join-Path $root 'ops\start-synrex-console.ps1')
    manual_launcher = $manualLauncher
    manual_shortcut = $manualShortcut
    deployment = (Join-Path $installedDeploymentRoot 'deploy-group.ps1')
}
