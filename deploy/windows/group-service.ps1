param(
    [ValidateSet('Run', 'Install', 'Restart', 'Activate', 'Check')][string]$Action = 'Check',
    [Parameter(Mandatory = $true)][string]$PlatformRoot,
    [string]$SlotName = '',
    [switch]$LogonOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$taskName = 'Synrex Group Core'
$tunnelId = 'edbf2dd7-2cc1-434c-979a-2f6b387eebe3'
$tokenFile = Join-Path $root 'state\secrets\cloudflare-tunnel-token.txt'
$pointer = Join-Path $root 'runtime\active-slot.txt'
$installedScript = Join-Path $root 'ops\group-service.ps1'
$utf8 = New-Object Text.UTF8Encoding($false)

function Get-Slot([string]$name) {
    if (!$name) { $name = [IO.File]::ReadAllText($pointer).Trim() }
    if ($name -notmatch '^synrex-windows-[A-Za-z0-9._-]+$') { throw 'Invalid Group slot name.' }
    $directory = Join-Path $root ('runtime\slots\' + $name)
    $node = Join-Path $directory 'node\node.exe'
    $cli = Join-Path $directory 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
    foreach ($file in @($node, $cli, (Join-Path $directory 'READY'), (Join-Path $directory 'slot.json'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Incomplete slot: $file" }
    }
    return @{ Name = $name; Root = $directory; Node = $node; Cli = $cli }
}

function Assert-GroupConfig {
    $config = Get-Content -LiteralPath (Join-Path $root 'state\devspace-config\config.jsonc') -Raw | ConvertFrom-Json
    if ($config.server.port -ne 17677 -or $config.server.host -ne '127.0.0.1' -or $config.server.publicBaseUrl -ne 'https://dev.sanqi.org/group') {
        throw 'Refusing non-Group endpoint configuration.'
    }
    $token = [IO.File]::ReadAllText($tokenFile).Trim()
    $metadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($token)) | ConvertFrom-Json
    if ($metadata.t -ne $tunnelId -or !$metadata.s) { throw 'Group Tunnel credential identity mismatch.' }
    $token = $null
    $metadata = $null
}

function Get-GroupTunnels {
    @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object {
        $_.ExecutablePath -eq (Join-Path $root 'cloudflared.exe') -and
        $_.CommandLine -match [regex]::Escape('--token-file "' + $tokenFile + '"')
    })
}

function Assert-FreePort([int]$port) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is occupied; refusing to take over an existing process."
    }
}

function Get-HttpStatus([string]$url) {
    try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 8).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return 0 }
}

function Wait-Endpoint([string]$url, [int]$expected, [int]$seconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        if ((Get-HttpStatus $url) -eq $expected) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Readiness failed: $url expected HTTP $expected"
}

function Test-Chain {
    foreach ($probe in @(
        @('http://127.0.0.1:17677/group/healthz', 200),
        @('http://127.0.0.1:20243/ready', 200),
        @('https://group-origin.sanqi.org/group/healthz', 200),
        @('https://dev.sanqi.org/group/healthz', 200),
        @('http://127.0.0.1:17677/group/mcp', 401),
        @('https://dev.sanqi.org/group/mcp', 401),
        @('https://dev.sanqi.org/.well-known/oauth-protected-resource/group/mcp', 200),
        @('http://127.0.0.1:17677/console', 200)
    )) {
        Wait-Endpoint $probe[0] $probe[1]
        Write-Output ($probe[0] + ' HTTP=' + $probe[1])
    }
}

function Stop-Group {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $args = [string]$task.Actions[0].Arguments
        $legacy = Join-Path $root 'ops\start-synrex-background.ps1'
        if ($task.Actions.Count -ne 1 -or (!$args.Contains($installedScript) -and !$args.Contains($legacy))) {
            throw 'Unexpected scheduled-task owner; refusing to stop it.'
        }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    # Match only the Group token file; Qwen uses the same executable.
    foreach ($process in Get-GroupTunnels) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (!(Get-NetTCPConnection -State Listen -LocalPort 17677 -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    Assert-FreePort 17677
    Assert-FreePort 20243
}

function Install-Task {
    if ($PSCommandPath -ne $installedScript) { Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedScript + '" -Action Run -PlatformRoot "' + $root + '"'
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $(if ($LogonOnly) { 'Interactive' } else { 'S4U' }) -RunLevel Limited
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $user))
    if (!$LogonOnly) { $triggers += New-ScheduledTaskTrigger -AtStartup }
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Settings $settings -Trigger $triggers -Principal $principal -Force -ErrorAction Stop | Out-Null
    $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($registered.Actions[0].Arguments -ne $arguments -or [string]$registered.Principal.LogonType -ne [string]$principal.LogonType) {
        throw 'Scheduled-task registration did not persist the requested startup chain.'
    }
}

Assert-GroupConfig
$slot = Get-Slot $SlotName
if ($Action -eq 'Check') { Test-Chain; exit 0 }
if ($Action -eq 'Run') {
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-', '').Substring(0, 16)
    $mutex = New-Object Threading.Mutex($false, ('Global\SynrexGroup-' + $hash))
    $ownsMutex = $false
    $core = $null
    $tunnel = $null
    $log = Join-Path $root 'logs\group-service.log'
    try {
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (!$ownsMutex) { Write-Output 'Group supervisor already owns the startup chain.'; exit 0 }
        Assert-FreePort 17677
        Assert-FreePort 20243
        if (@(Get-GroupTunnels).Count -gt 0) { throw 'A standalone Group Tunnel is running; use Restart to transfer ownership.' }
        $env:DEVSPACE_CONFIG_DIR = Join-Path $root 'state\devspace-config'
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $core = Start-Process -FilePath $slot.Node -ArgumentList @(('"' + $slot.Cli + '"'), 'serve') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root ('logs\group-core-' + $stamp + '.stdout.log')) -RedirectStandardError (Join-Path $root ('logs\group-core-' + $stamp + '.stderr.log')) -PassThru
        Wait-Endpoint 'http://127.0.0.1:17677/group/healthz' 200
        if ($core.HasExited -or (Get-NetTCPConnection -State Listen -LocalPort 17677).OwningProcess -ne $core.Id) { throw 'Core listener is not owned by the launched process.' }
        do {
            if (!$tunnel -or $tunnel.HasExited) {
                Assert-FreePort 20243
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                $tunnel = Start-Process -FilePath (Join-Path $root 'cloudflared.exe') -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:20243', 'run', '--token-file', ('"' + $tokenFile + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stdout.log')) -RedirectStandardError (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stderr.log')) -PassThru
                Test-Chain | ForEach-Object { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $_) }
                Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' READY slot=' + $slot.Name + ' core=' + $core.Id + ' tunnel=' + $tunnel.Id)
            }
            Start-Sleep -Seconds 3
            if ($core.HasExited) { throw 'Group Core exited; scheduled-task recovery will restart the chain.' }
        } while ($true)
    } catch {
        Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' FAILED ' + $_.Exception.Message)
        exit 1
    } finally {
        foreach ($child in @($tunnel, $core)) { if ($child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit(5000) | Out-Null } }
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($Action -eq 'Restart') {
    $currentTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if (!$currentTask.Actions[0].Arguments.Contains($installedScript)) { throw 'Install the Group supervisor before restarting it.' }
    Stop-Group
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Test-Chain
    exit 0
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Install or Activate from elevated PowerShell; production has not been stopped.'
}
if ($Action -eq 'Activate' -and !$SlotName) { throw 'Activate requires a candidate SlotName.' }
$backup = Join-Path $root ('runtime-backups\group-startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
$acl = Get-Acl -LiteralPath $backup
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $backup -AclObject $acl
$oldSlot = [IO.File]::ReadAllText($pointer).Trim()
$oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($oldTask) { Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backup 'task.xml') -Encoding UTF8 }
Copy-Item -LiteralPath $pointer -Destination (Join-Path $backup 'active-slot.txt')
if (Test-Path -LiteralPath $installedScript) { Copy-Item -LiteralPath $installedScript -Destination (Join-Path $backup 'group-service.ps1') }
$taskChanged = $false
try {
    Stop-Group
    $stateBackup = Join-Path $backup 'state'
    New-Item -ItemType Directory -Path $stateBackup | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'state\devspace-config') -Destination $stateBackup -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'state\devspace-state') -Destination $stateBackup -Recurse
    if ($Action -eq 'Activate') { [IO.File]::WriteAllText($pointer, $slot.Name + [Environment]::NewLine, $utf8) }
    $taskChanged = $true
    Install-Task
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Test-Chain
    Write-Output ('Group chain ready; rollback snapshot: ' + $backup)
} catch {
    $failure = $_
    if ($taskChanged) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    [IO.File]::WriteAllText($pointer, $oldSlot + [Environment]::NewLine, $utf8)
    if (Test-Path -LiteralPath (Join-Path $backup 'group-service.ps1')) { Copy-Item -LiteralPath (Join-Path $backup 'group-service.ps1') -Destination $installedScript -Force }
    if ($oldTask) {
        if ($taskChanged) { Register-ScheduledTask -TaskName $taskName -Xml ([IO.File]::ReadAllText((Join-Path $backup 'task.xml'))) -Force -ErrorAction Stop | Out-Null }
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    # The old Core-only task cannot restore its Tunnel; restore only this Group credential.
    if (@(Get-GroupTunnels).Count -eq 0) {
        Start-Process -FilePath (Join-Path $root 'cloudflared.exe') -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:20243', 'run', '--token-file', ('"' + $tokenFile + '"')) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    }
    throw $failure
}
