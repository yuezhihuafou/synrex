param(
    [Parameter(Mandatory = $true)][string]$PlatformRoot,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$desktopRoot = Join-Path $root 'desktop'
$appRoot = Join-Path $desktopRoot 'resources\app'
$launcher = Join-Path $root 'ops\start-modern-desktop.ps1'
$legacyExe = Join-Path $desktopRoot 'DevSpaceForgeDesktop.exe'
$synrexExe = Join-Path $desktopRoot 'SynrexConsole.exe'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backup = Join-Path $root "state\runtime-rollback\synrex-console-desktop-$stamp"

foreach ($file in @($launcher, $legacyExe)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required Windows Console asset missing: $file" }
}
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'start-modern-desktop.ps1')
if (Test-Path -LiteralPath $appRoot) { Copy-Item -LiteralPath $appRoot -Destination (Join-Path $backup 'app') -Recurse }

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\main.cjs') -Destination (Join-Path $appRoot 'main.cjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\package.json') -Destination (Join-Path $appRoot 'package.json') -Force
if (-not (Test-Path -LiteralPath $synrexExe)) { Copy-Item -LiteralPath $legacyExe -Destination $synrexExe }

$text = Get-Content -Raw -LiteralPath $launcher
$text = $text.Replace("`$desktop = Join-Path `$root 'desktop\DevSpaceForgeDesktop.exe'", "`$desktop = Join-Path `$root 'desktop\SynrexConsole.exe'")
$needle = "`$env:DEVSPACE_CONTROL_URL = `$url"
if (-not $text.Contains('$env:SYNREX_CONSOLE_URL')) {
    $text = $text.Replace($needle, $needle + "`r`n    `$env:SYNREX_CONSOLE_URL = 'http://127.0.0.1:17677/console'")
}
[IO.File]::WriteAllText($launcher, $text, [Text.UTF8Encoding]::new($false))

if ($Restart) {
    Get-CimInstance Win32_Process -Filter "Name='SynrexConsole.exe' OR Name='DevSpaceForgeDesktop.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-File',('"' + $launcher + '"'),'-PlatformRoot',('"' + $root + '"')) -WindowStyle Hidden | Out-Null
}

[PSCustomObject]@{
    product = 'Synrex Console'
    executable = $synrexExe
    console_url = 'http://127.0.0.1:17677/console'
    backup = $backup
}
