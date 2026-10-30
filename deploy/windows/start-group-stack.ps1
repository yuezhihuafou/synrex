param(
    [string]$PlatformRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PlatformRoot)) {
    $PlatformRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$bundledService = Join-Path $PSScriptRoot 'group-service.ps1'
$installedService = Join-Path $root 'ops\group-service.ps1'
$service = if (Test-Path -LiteralPath $bundledService -PathType Leaf) { $bundledService } else { $installedService }

if (!(Test-Path -LiteralPath $service -PathType Leaf)) {
    throw "Group supervisor is missing: $service"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @(
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $PSCommandPath + '"'),
        '-PlatformRoot', ('"' + $root + '"')
    )
    # Start-Process -Wait waits for the supervisor's entire long-running tree.
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
    $elevated.WaitForExit()
    exit $elevated.ExitCode
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $service -Action ManualStart -PlatformRoot $root
exit $LASTEXITCODE
