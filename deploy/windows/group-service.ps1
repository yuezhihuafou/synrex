param(
    [ValidateSet('Run', 'Install', 'Restart', 'Activate', 'Check', 'ManualStart')][string]$Action = 'Check',
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
$consoleLauncher = Join-Path $root 'ops\start-synrex-console.ps1'
$processReceipt = Join-Path $root 'state\group-service-core.json'
$utf8 = New-Object Text.UTF8Encoding($false)
$stateDirectoriesToBackup = @('diagnostics', 'jobs', 'observability', 'operations', 'payload-spool')
$stateDirectoriesExcludedFromBackup = @('compact-runs')
$backupFreeSpaceReserveBytes = 256MB

function Get-DirectoryBytes([string]$path) {
    if (!(Test-Path -LiteralPath $path -PathType Container)) { return [long]0 }
    $measurement = Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction Stop |
        Measure-Object -Property Length -Sum
    if ($null -eq $measurement.Sum) { return [long]0 }
    return [long]$measurement.Sum
}

function Get-StateBackupRequiredBytes {
    $configRoot = Join-Path $root 'state\devspace-config'
    $stateRoot = Join-Path $root 'state\devspace-state'
    $bytes = Get-DirectoryBytes $configRoot
    if (!(Test-Path -LiteralPath $stateRoot -PathType Container)) { return [long]$bytes }

    $knownDirectories = @($stateDirectoriesToBackup + $stateDirectoriesExcludedFromBackup)
    $unknownDirectories = @(Get-ChildItem -LiteralPath $stateRoot -Directory -Force | Where-Object {
        $_.Name -notin $knownDirectories
    })
    if ($unknownDirectories.Count -gt 0) {
        throw ('Unknown Group state directories require an explicit backup policy before activation: ' +
            (($unknownDirectories | ForEach-Object Name) -join ', '))
    }
    foreach ($file in Get-ChildItem -LiteralPath $stateRoot -File -Force) { $bytes += [long]$file.Length }
    foreach ($name in $stateDirectoriesToBackup) { $bytes += Get-DirectoryBytes (Join-Path $stateRoot $name) }
    return [long]$bytes
}

function Assert-StateBackupCapacity {
    $required = Get-StateBackupRequiredBytes
    $driveRoot = [IO.Path]::GetPathRoot($root)
    $drive = New-Object IO.DriveInfo($driveRoot)
    $minimumFree = $required + $backupFreeSpaceReserveBytes
    if ($drive.AvailableFreeSpace -lt $minimumFree) {
        throw ('Insufficient disk space for Group activation before production stop. ' +
            'free=' + $drive.AvailableFreeSpace + ' requiredBackup=' + $required +
            ' reserve=' + $backupFreeSpaceReserveBytes)
    }
    return @{ RequiredBytes = $required; FreeBytes = [long]$drive.AvailableFreeSpace }
}

function Backup-GroupState([string]$stateBackup, [hashtable]$capacity) {
    $configRoot = Join-Path $root 'state\devspace-config'
    $stateRoot = Join-Path $root 'state\devspace-state'
    Copy-Item -LiteralPath $configRoot -Destination $stateBackup -Recurse
    $stateDestination = Join-Path $stateBackup 'devspace-state'
    New-Item -ItemType Directory -Path $stateDestination | Out-Null
    if (Test-Path -LiteralPath $stateRoot -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $stateRoot -File -Force) {
            Copy-Item -LiteralPath $file.FullName -Destination $stateDestination
        }
        foreach ($name in $stateDirectoriesToBackup) {
            $source = Join-Path $stateRoot $name
            if (Test-Path -LiteralPath $source -PathType Container) {
                Copy-Item -LiteralPath $source -Destination $stateDestination -Recurse
            }
        }
    }
    $excluded = foreach ($name in $stateDirectoriesExcludedFromBackup) {
        $source = Join-Path $stateRoot $name
        [ordered]@{
            path = ('devspace-state\\' + $name)
            bytes = Get-DirectoryBytes $source
            reason = 'append-only execution history; activation does not replace or delete the live directory'
        }
    }
    [ordered]@{
        version = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        requiredBackupBytes = $capacity.RequiredBytes
        freeBytesBeforeStop = $capacity.FreeBytes
        excluded = @($excluded)
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stateBackup 'backup-manifest.json') -Encoding UTF8
}

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

function Get-OwnedCoreProcesses {
    $slotRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime\slots'))).TrimEnd('\') + '\'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $executable = [string]$_.ExecutablePath
        $command = [string]$_.CommandLine
        $executable.StartsWith($slotRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $command -match '(?i)\\devspace\\node_modules\\@waishnav\\devspace\\dist\\cli\.js"?\s+serve(?:\s|$)'
    })
}

function Get-OwnedSupervisors {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $command = [string]$_.CommandLine
        $command.IndexOf($installedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command -match '(?i)-Action\s+Run(?:\s|$)' -and
        $command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Get-OwnedControls {
    $consoleScript = Join-Path $root 'ops\runtime-console.mjs'
    $slotRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime\slots'))).TrimEnd('\') + '\'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $executable = [string]$_.ExecutablePath
        $command = [string]$_.CommandLine
        $executable.StartsWith($slotRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $command.IndexOf($consoleScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command -match '(?i)--instance\s+group(?:\s|$)' -and
        $command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Get-ControlManagedServiceChildren {
    $controls = @(Get-OwnedControls)
    if ($controls.Count -eq 0) { return @() }
    $controlIds = @($controls | ForEach-Object { [int]$_.ProcessId })
    $slotRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime\slots'))).TrimEnd('\') + '\'
    $managedTunnel = [IO.Path]::GetFullPath((Join-Path $root 'ops\managed-cloudflared.mjs'))
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $command = [string]$_.CommandLine
        $executable = [string]$_.ExecutablePath
        $controlIds -contains [int]$_.ParentProcessId -and
        $executable.StartsWith($slotRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (
            $command.IndexOf($managedTunnel, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $command -match '(?i)\\devspace\\node_modules\\@waishnav\\devspace\\dist\\cli\.js"?\s+serve(?:\s|$)'
        )
    })
}

function Get-OwnedDesktopShells {
    $expected = @(
        [IO.Path]::GetFullPath((Join-Path $root 'desktop\SynrexConsole.exe')),
        [IO.Path]::GetFullPath((Join-Path $root 'desktop\DevSpaceForgeDesktop.exe'))
    )
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $executable = [string]$_.ExecutablePath
        $owned = $false
        foreach ($path in $expected) {
            if (!$owned -and !$([string]::IsNullOrWhiteSpace($executable)) -and
                $executable.Equals($path, [StringComparison]::OrdinalIgnoreCase)) {
                $owned = $true
            }
        }
        $owned
    })
}

function Stop-ProcessList([object[]]$processes, [string]$label) {
    foreach ($process in @($processes | Sort-Object ProcessId -Unique)) {
        Write-Output ('Stopping owned ' + $label + ' PID ' + $process.ProcessId)
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
    }
}

function Stop-ProcessTreeList([object[]]$processes, [string]$label) {
    foreach ($process in @($processes | Sort-Object ProcessId -Unique)) {
        $processId = [int]$process.ProcessId
        Write-Output ('Stopping owned ' + $label + ' tree PID ' + $processId)
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $processId /T /F 2>&1 | Out-Null
        Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            throw ('Owned ' + $label + ' process tree did not exit: PID ' + $processId)
        }
    }
}

function Remove-ControlManagedServiceChildren {
    # The legacy Windows Control restores its own Core/Tunnel children when it
    # starts. ManualStart keeps Control for its management API but makes the
    # Group supervisor the only runtime owner by reconciling those children.
    $stablePasses = 0
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $children = @(Get-ControlManagedServiceChildren)
        if ($children.Count -gt 0) {
            Stop-ProcessTreeList $children 'Control-managed service'
            $stablePasses = 0
        } else {
            $stablePasses++
            if ($stablePasses -ge 4) { return }
        }
        Start-Sleep -Milliseconds 500
    }
    $remaining = @(Get-ControlManagedServiceChildren)
    if ($remaining.Count -gt 0) {
        throw ('Windows Control kept spawning managed service children: ' + (($remaining | ForEach-Object ProcessId) -join ','))
    }
}

function Get-OwnedSnapshotCollectors {
    $script = [IO.Path]::GetFullPath((Join-Path $root 'ops\deployment\group-console-snapshot.mjs'))
    $slotRoot = ([IO.Path]::GetFullPath((Join-Path $root 'runtime\slots'))).TrimEnd('\') + '\'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        ([string]$_.ExecutablePath).StartsWith($slotRoot, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.CommandLine).IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Stop-ManualStack {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $args = [string]$task.Actions[0].Arguments
        $legacy = Join-Path $root 'ops\start-synrex-background.ps1'
        if ($task.Actions.Count -ne 1 -or (!$args.Contains($installedScript) -and !$args.Contains($legacy))) {
            throw 'Unexpected scheduled-task owner; refusing manual cleanup.'
        }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }

    Stop-ProcessList @(Get-OwnedSnapshotCollectors) 'Console snapshot collector'
    Stop-ProcessList @(Get-OwnedSupervisors) 'Group supervisor'
    Start-Sleep -Milliseconds 600
    Stop-ProcessList @(Get-OwnedCoreProcesses) 'Group Core'
    Stop-ProcessList @(Get-OwnedControls) 'Windows Control'
    Stop-ProcessList @(Get-OwnedDesktopShells) 'Console shell'
    Stop-ProcessList @(Get-GroupTunnels) 'Group Tunnel'
    Remove-Item -LiteralPath $processReceipt -Force -ErrorAction SilentlyContinue

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        $busy = @()
        foreach ($port in @(17677, 17678, 20243)) {
            if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { $busy += $port }
        }
        if ($busy.Count -eq 0) { return }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($port in @(17677, 17678, 20243)) { Assert-FreePort $port }
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

function Stop-OwnedCore {
    if (!(Test-Path -LiteralPath $processReceipt)) { return }
    $receipt = Get-Content -LiteralPath $processReceipt -Raw | ConvertFrom-Json
    $ownedSlot = Get-Slot $receipt.slot
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$receipt.pid)
    if (!$process -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $receipt.created) { return }
    if ($process.ExecutablePath -ne $ownedSlot.Node -or !$process.CommandLine.Contains(('"' + $ownedSlot.Cli + '" serve'))) {
        throw 'Recorded Group Core identity does not match; refusing to stop it.'
    }
    Stop-Process -Id $process.ProcessId -ErrorAction Stop
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
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

function Stop-Group([switch]$PreserveTunnel) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $args = [string]$task.Actions[0].Arguments
        $legacy = Join-Path $root 'ops\start-synrex-background.ps1'
        if ($task.Actions.Count -ne 1 -or (!$args.Contains($installedScript) -and !$args.Contains($legacy))) {
            throw 'Unexpected scheduled-task owner; refusing to stop it.'
        }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    Stop-OwnedCore
    # Match only the Group token file; Qwen uses the same executable.
    $groupTunnels = @(Get-GroupTunnels)
    if ($groupTunnels.Count -gt 1) {
        throw 'Multiple Group Tunnel processes are running; refusing an ambiguous handoff.'
    }
    if ($PreserveTunnel -and $groupTunnels.Count -eq 1 -and (Get-HttpStatus 'http://127.0.0.1:20243/ready') -eq 200) {
        Write-Output ('Preserving Group Tunnel PID ' + $groupTunnels[0].ProcessId + ' across Core cutover.')
    } else {
        foreach ($process in $groupTunnels) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
    }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (!(Get-NetTCPConnection -State Listen -LocalPort 17677 -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    Assert-FreePort 17677
    if (!$PreserveTunnel -or @(Get-GroupTunnels).Count -eq 0) { Assert-FreePort 20243 }
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

function Warm-CoreSlot([hashtable]$candidate) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $root ('logs\group-preload-' + $stamp + '.stdout.log')
    $stderr = Join-Path $root ('logs\group-preload-' + $stamp + '.stderr.log')
    $started = Get-Date
    $cliDirectory = Split-Path -Parent $candidate.Cli
    $cliName = Split-Path -Leaf $candidate.Cli
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $candidate.Node
    $startInfo.Arguments = $cliName + ' serve'
    $startInfo.WorkingDirectory = $cliDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['SYNREX_PRELOAD_ONLY'] = '1'
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (!$process.Start()) { throw 'Synrex Core preload process could not be started.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(90000)) {
        $process.Kill()
        $process.WaitForExit(5000) | Out-Null
        throw 'Synrex Core preload exceeded 90 seconds.'
    }
    $stdoutText = $stdoutTask.GetAwaiter().GetResult()
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText($stdout, $stdoutText, $utf8)
    [IO.File]::WriteAllText($stderr, $stderrText, $utf8)
    $exitCode = [int]$process.ExitCode
    if ($exitCode -ne 0) {
        $detail = (($stderrText -split "`r?`n") | Select-Object -Last 20) -join ' '
        throw ('Synrex Core preload failed with code ' + $exitCode + '. ' + $detail)
    }
    Write-Output ('Preloaded slot ' + $candidate.Name + ' in ' + [Math]::Round(((Get-Date) - $started).TotalMilliseconds) + ' ms before production stop.')
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
        # Task Scheduler can leave Start-Process children alive after stopping the supervisor.
        Stop-OwnedCore
        Assert-FreePort 17677
        $existingTunnels = @(Get-GroupTunnels)
        if ($existingTunnels.Count -gt 1) { throw 'Multiple Group Tunnel processes are running; refusing an ambiguous handoff.' }
        if ($existingTunnels.Count -eq 1) {
            if ((Get-HttpStatus 'http://127.0.0.1:20243/ready') -eq 200) {
                $tunnel = Get-Process -Id ([int]$existingTunnels[0].ProcessId) -ErrorAction Stop
                Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ADOPT tunnel=' + $tunnel.Id)
            } else {
                Stop-Process -Id $existingTunnels[0].ProcessId -ErrorAction Stop
                Wait-Process -Id $existingTunnels[0].ProcessId -Timeout 10 -ErrorAction SilentlyContinue
                Assert-FreePort 20243
            }
        } else {
            Assert-FreePort 20243
        }
        $env:DEVSPACE_CONFIG_DIR = Join-Path $root 'state\devspace-config'
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $core = Start-Process -FilePath $slot.Node -ArgumentList @(('"' + $slot.Cli + '"'), 'serve') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root ('logs\group-core-' + $stamp + '.stdout.log')) -RedirectStandardError (Join-Path $root ('logs\group-core-' + $stamp + '.stderr.log')) -PassThru
        $identity = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $core.Id)
        @{ slot = $slot.Name; pid = $core.Id; created = $identity.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $processReceipt -Encoding UTF8
        Wait-Endpoint 'http://127.0.0.1:17677/group/healthz' 200
        if ($core.HasExited -or (Get-NetTCPConnection -State Listen -LocalPort 17677).OwningProcess -ne $core.Id) { throw 'Core listener is not owned by the launched process.' }
        if (!$tunnel -or $tunnel.HasExited) {
            Assert-FreePort 20243
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $tunnel = Start-Process -FilePath (Join-Path $root 'cloudflared.exe') -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:20243', 'run', '--token-file', ('"' + $tokenFile + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stdout.log')) -RedirectStandardError (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stderr.log')) -PassThru
        }
        Test-Chain | ForEach-Object { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $_) }
        Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' READY slot=' + $slot.Name + ' core=' + $core.Id + ' tunnel=' + $tunnel.Id)
        do {
            Start-Sleep -Seconds 3
            if ($core.HasExited) { throw 'Group Core exited; scheduled-task recovery will restart the chain.' }
            if ($tunnel.HasExited) {
                Assert-FreePort 20243
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                $tunnel = Start-Process -FilePath (Join-Path $root 'cloudflared.exe') -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:20243', 'run', '--token-file', ('"' + $tokenFile + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stdout.log')) -RedirectStandardError (Join-Path $root ('logs\group-tunnel-' + $stamp + '.stderr.log')) -PassThru
                Test-Chain | ForEach-Object { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $_) }
                Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' READY slot=' + $slot.Name + ' core=' + $core.Id + ' tunnel=' + $tunnel.Id)
            }
        } while ($true)
    } catch {
        Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' FAILED ' + $_.Exception.Message)
        exit 1
    } finally {
        # The Group Tunnel is node-level transport state, not slot-level Core state.
        # Keep it alive when the supervisor exits so Activate/Restart can hand it
        # across Core cutovers without forcing a new Cloudflare connector handshake.
        # Explicit Stop-Group without -PreserveTunnel remains the authority for
        # deliberately stopping the Group Tunnel.
        if ($core -and !$core.HasExited) { $core.Kill(); $core.WaitForExit(5000) | Out-Null }
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Install, Activate, Restart or ManualStart from elevated PowerShell; production has not been stopped.'
}
if ($Action -eq 'ManualStart') {
    $trayLauncher = Join-Path $root 'ops\deployment\start-group-tray.vbs'
    $snapshotCollector = Join-Path $root 'ops\deployment\group-console-snapshot.mjs'
    foreach ($required in @($installedScript, $consoleLauncher, $trayLauncher, $snapshotCollector)) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Manual launcher dependency missing: $required" }
    }
    Stop-ManualStack
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedScript + '" -Action Run -PlatformRoot "' + $root + '"'
    $supervisor = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Wait-Endpoint 'http://127.0.0.1:17677/group/healthz' 200 90
    Wait-Endpoint 'http://127.0.0.1:20243/ready' 200 90
    $supervisor.Refresh()
    if ($supervisor.HasExited) { throw "Manual Group supervisor exited with code $($supervisor.ExitCode)." }
    Test-Chain

    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $consoleLauncher -PlatformRoot $root -ControlOnly
    if ($LASTEXITCODE -ne 0) { throw 'Synrex Console launcher failed during manual startup.' }
    Start-Sleep -Seconds 5
    Remove-ControlManagedServiceChildren
    Wait-Endpoint 'http://127.0.0.1:17677/group/healthz' 200 30
    Wait-Endpoint 'http://127.0.0.1:20243/ready' 200 30
    $collector = Start-Process -FilePath $slot.Node -ArgumentList @(('"' + $snapshotCollector + '"'), ('"' + $root + '"'), ('"' + $slot.Name + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $root 'logs\group-console-snapshot.stderr.log') -PassThru
    # Explorer opens the tray launcher with the interactive user's token.
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $trayLauncher + '"') -WindowStyle Hidden | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $desktop = @(Get-OwnedDesktopShells)
        if ($desktop.Count -gt 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $control = @(Get-OwnedControls)
    if ($desktop.Count -eq 0) { throw 'Synrex Console did not remain running after manual startup.' }
    if ($control.Count -eq 0) { throw 'Windows Control did not remain running after manual startup.' }
    $collector.Refresh()
    if ($collector.HasExited) { throw 'Console snapshot collector exited during manual startup.' }

    $core = @(Get-OwnedCoreProcesses)
    $tunnel = @(Get-GroupTunnels)
    if ($core.Count -ne 1 -or $tunnel.Count -ne 1) {
        throw ('Manual startup ended with an unexpected owned-process count: core=' + $core.Count + ' tunnel=' + $tunnel.Count)
    }
    [PSCustomObject]@{
        status = 'ready'
        mode = 'manual'
        slot = $slot.Name
        core_pid = [int]$core[0].ProcessId
        tunnel_pid = [int]$tunnel[0].ProcessId
        control_pid = [int]$control[0].ProcessId
        console_pid = [int]$desktop[0].ProcessId
        control_managed_children = 0
        scheduled_task = 'stopped'
    }
    exit 0
}
if ($Action -eq 'Restart') {
    $currentTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if (!$currentTask.Actions[0].Arguments.Contains($installedScript)) { throw 'Install the Group supervisor before restarting it.' }
    Warm-CoreSlot $slot
    Stop-Group -PreserveTunnel
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Test-Chain
    exit 0
}
if ($Action -eq 'Activate' -and !$SlotName) { throw 'Activate requires a candidate SlotName.' }
$backupCapacity = Assert-StateBackupCapacity
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
    Warm-CoreSlot $slot
    Stop-Group -PreserveTunnel
    $stateBackup = Join-Path $backup 'state'
    New-Item -ItemType Directory -Path $stateBackup | Out-Null
    Backup-GroupState $stateBackup $backupCapacity
    if ($Action -eq 'Activate') { [IO.File]::WriteAllText($pointer, $slot.Name + [Environment]::NewLine, $utf8) }
    $taskChanged = $true
    Install-Task
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Test-Chain
    Write-Output ('Group chain ready; rollback snapshot: ' + $backup)
} catch {
    $failure = $_
    if ($taskChanged) { Stop-Group }
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
