# Synrex Windows upgrade preflight (read-only). PowerShell 5.1+.
param([int]$Port = 7676)
$ErrorActionPreference = 'Stop'
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -match '(?i)(synrex|devspace)' } |
  ForEach-Object {
    [pscustomobject]@{ Name = $_.TaskName; State = [string]$_.State;
      Path = $_.TaskPath; Actions = @($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) }
  })
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    $pidValue = $_.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
    [pscustomobject]@{ Port = $Port; Pid = $pidValue;
      Executable = $process.ExecutablePath; CommandLine = $process.CommandLine }
  })
$prefix = Join-Path $env:LOCALAPPDATA 'Synrex\portable'
$pointer = Join-Path $prefix 'current.json'
$current = if (Test-Path $pointer) {
  Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json
} else { $null }
[pscustomobject]@{
  ReadOnly = $true
  Port = $Port
  ListeningProcesses = $listeners
  ScheduledTasks = $tasks
  PortableCurrent = $current
  Warning = 'Review legacy services and port ownership before cutover; nothing was changed.'
} | ConvertTo-Json -Depth 6
