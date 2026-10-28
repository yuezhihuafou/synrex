param(
    [Parameter(Mandatory = $true)][string]$PlatformRoot
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$taskName = 'Synrex Group Core'
$desktop = Join-Path $root 'desktop\SynrexConsole.exe'
$startControl = Join-Path $root 'ops\start-runtime-console.ps1'
$consoleScript = Join-Path $root 'ops\runtime-console.mjs'
$profile = Join-Path $root 'state\synrex-console-profile'

foreach ($required in @($desktop, $startControl, $consoleScript)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Synrex Console asset is missing: $required"
    }
}

function Get-Status([string]$url) {
    try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return 0 }
}

function Wait-Status([string]$url, [int]$expected, [int]$seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        if ((Get-Status $url) -eq $expected) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $url HTTP $expected"
}

if ((Get-Status 'http://127.0.0.1:17677/group/healthz') -ne 200) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.Actions.Count -ne 1 -or !$task.Actions[0].Arguments.Contains('group-service.ps1')) {
        throw 'Synrex Group scheduled task is not owned by the current deployment.'
    }
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Wait-Status 'http://127.0.0.1:17677/group/healthz' 200 45
}

$controlUrl = 'http://127.0.0.1:17678'
function Test-ControlReady {
    try {
        $status = Invoke-WebRequest -UseBasicParsing -Uri ($controlUrl + '/api/status') -TimeoutSec 2
        $body = $status.Content | ConvertFrom-Json
        if ($status.StatusCode -ne 200 -or $body.schema_version -ne 2 -or $body.security.loopback_console_only -ne $true) {
            return $false
        }
        $configuredPackage = [IO.Path]::GetFullPath([string]$body.runtime.configured.package_root)
        $runtimeRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime'))).TrimEnd('\') + '\'
        return $configuredPackage.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

if (!(Test-ControlReady)) {
    if (Get-NetTCPConnection -State Listen -LocalPort 17678 -ErrorAction SilentlyContinue) {
        throw 'Port 17678 is occupied by a Control instance that does not belong to this PlatformRoot.'
    }
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $startControl + '"'), '-PlatformRoot', ('"' + $root + '"'),
        '-Port', '17678', '-Instance', 'group'
    ) -WindowStyle Hidden | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (Test-ControlReady) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!(Test-ControlReady)) { throw 'Windows Control did not become ready on 127.0.0.1:17678.' }
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null
$env:DEVSPACE_PLATFORM_ROOT = $root
$env:DEVSPACE_CONTROL_URL = $controlUrl + '/'
$env:SYNREX_WINDOWS_CONTROL_URL = $controlUrl
$env:SYNREX_CONSOLE_URL = 'http://127.0.0.1:17677/console'
$env:SYNREX_CONSOLE_PROFILE_DIR = $profile
Start-Process -FilePath $desktop -WorkingDirectory $root | Out-Null

Write-Output 'Synrex Console started.'
Write-Output ('Console: ' + $env:SYNREX_CONSOLE_URL)
Write-Output ('Profile: ' + $profile)
