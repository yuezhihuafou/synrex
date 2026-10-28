param(
    [Parameter(Mandatory = $true)][string]$PlatformRoot,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$desktopRoot = Join-Path $root 'desktop'
$appRoot = Join-Path $desktopRoot 'resources\app'
$launcherSource = Join-Path $PSScriptRoot 'start-synrex-console.ps1'
$launcher = Join-Path $root 'ops\start-synrex-console.ps1'
$legacyExe = Join-Path $desktopRoot 'DevSpaceForgeDesktop.exe'
$synrexExe = Join-Path $desktopRoot 'SynrexConsole.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Synrex Console.lnk'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backup = Join-Path $root "state\runtime-rollback\synrex-console-desktop-$stamp"

foreach ($file in @($launcherSource, $legacyExe)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required Windows Console asset missing: $file" }
}
New-Item -ItemType Directory -Force -Path $backup | Out-Null
if (Test-Path -LiteralPath $launcher) { Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'start-synrex-console.ps1') }
if (Test-Path -LiteralPath $shortcut) { Copy-Item -LiteralPath $shortcut -Destination (Join-Path $backup 'Synrex Console.lnk') }
if (Test-Path -LiteralPath $appRoot) { Copy-Item -LiteralPath $appRoot -Destination (Join-Path $backup 'app') -Recurse }

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\main.cjs') -Destination (Join-Path $appRoot 'main.cjs') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\package.json') -Destination (Join-Path $appRoot 'package.json') -Force
Copy-Item -LiteralPath $launcherSource -Destination $launcher -Force
if (-not (Test-Path -LiteralPath $synrexExe)) { Copy-Item -LiteralPath $legacyExe -Destination $synrexExe }

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$link.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '" -PlatformRoot "' + $root + '"'
$link.WorkingDirectory = $root
$link.IconLocation = $synrexExe + ',0'
$link.Description = 'Open Synrex Console for this Windows node'
$link.Save()

if ($Restart) {
    Get-CimInstance Win32_Process -Filter "Name='SynrexConsole.exe' OR Name='DevSpaceForgeDesktop.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $remaining = @(Get-CimInstance Win32_Process -Filter "Name='SynrexConsole.exe' OR Name='DevSpaceForgeDesktop.exe'" -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $stopDeadline)
    if ($remaining.Count -ne 0) {
        throw 'Previous desktop shell processes did not exit before Synrex Console restart.'
    }
    # The launcher owns a named mutex while it waits for Electron. Give the
    # previous launcher a brief chance to observe Electron exit and release it.
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $launcher + '"'),'-PlatformRoot',('"' + $root + '"')) -WindowStyle Hidden | Out-Null
    $startDeadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 250
        $started = @(Get-CimInstance Win32_Process -Filter "Name='SynrexConsole.exe'" -ErrorAction SilentlyContinue)
        if ($started.Count -gt 0) { break }
    } while ([DateTime]::UtcNow -lt $startDeadline)
    if ($started.Count -eq 0) {
        throw 'Synrex Console launcher returned without starting SynrexConsole.exe.'
    }
}

[PSCustomObject]@{
    product = 'Synrex Console'
    executable = $synrexExe
    console_url = 'http://127.0.0.1:17677/console'
    launcher = $launcher
    shortcut = $shortcut
    backup = $backup
}
