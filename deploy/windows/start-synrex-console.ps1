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
function Get-ControlState {
    try {
        $status = Invoke-WebRequest -UseBasicParsing -Uri ($controlUrl + '/api/status') -TimeoutSec 2
        $body = $status.Content | ConvertFrom-Json
        if ($status.StatusCode -ne 200 -or $body.schema_version -ne 2 -or $body.security.loopback_console_only -ne $true) {
            return 'foreign'
        }
        if ([string]$body.instance -ne 'group') {
            return 'foreign'
        }
        $configuredPackage = [IO.Path]::GetFullPath([string]$body.runtime.configured.package_root)
        $runtimeRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime'))).TrimEnd('\') + '\'
        if (!$configuredPackage.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
            return 'foreign'
        }
        return 'ready'
    } catch { return 'unavailable' }
}

$controlState = Get-ControlState
if ($controlState -ne 'ready') {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 17678 -ErrorAction SilentlyContinue
    if ($listener) {
        # A healthy local Control can briefly stop answering while its runtime
        # view refreshes after slot activation. Do not misclassify that normal
        # transition as a foreign port owner after a single HTTP timeout.
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        do {
            if ($controlState -eq 'foreign') {
                throw 'Port 17678 belongs to a Control instance that does not match this Group PlatformRoot.'
            }
            Start-Sleep -Milliseconds 400
            $controlState = Get-ControlState
        } while ($controlState -ne 'ready' -and [DateTime]::UtcNow -lt $deadline)
        if ($controlState -ne 'ready') {
            throw 'Existing Windows Control on 17678 did not become ready for this Group PlatformRoot.'
        }
    }
    if ($controlState -ne 'ready') {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
            '-File', ('"' + $startControl + '"'), '-PlatformRoot', ('"' + $root + '"'),
            '-Port', '17678', '-Instance', 'group'
        ) -WindowStyle Hidden | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $controlState = Get-ControlState
            if ($controlState -eq 'ready') { break }
            if ($controlState -eq 'foreign') {
                throw 'Windows Control started on 17678 with the wrong Group identity.'
            }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($controlState -ne 'ready') { throw 'Windows Control did not become ready on 127.0.0.1:17678.' }
    }
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
