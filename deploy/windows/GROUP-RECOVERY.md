# Windows Group startup and recovery

The packaged `deploy/windows/group-service.ps1` owns the existing `Synrex Group Core`
scheduled task. It starts the active slot's Core, waits for localhost health,
starts only Group Tunnel `edbf2dd7-2cc1-434c-979a-2f6b387eebe3` with HTTP/2 and
`--token-file`, then verifies Tunnel readiness, origin/public health, local/public
MCP 401 challenges, OAuth resource metadata and Console. Qwen is never selected by
executable name alone. Occupied ports fail closed. A named mutex prevents duplicate
supervisors; an exited Tunnel is restarted, and a failed Core is recovered by the
scheduled task. No token value is passed to a command or written to logs.

Run PowerShell as the owner, elevated for installation, activation or restart:

```powershell
& .\deploy\windows\group-service.ps1 -Action Activate -PlatformRoot $groupRoot -SlotName $verifiedCandidate
& .\deploy\windows\group-service.ps1 -Action Restart -PlatformRoot $groupRoot
& .\deploy\windows\group-service.ps1 -Action Check -PlatformRoot $groupRoot
```

For a normal tested package promotion, prefer the single deployment entrypoint:

```powershell
& .\deploy\windows\deploy-group.ps1 -PlatformRoot $groupRoot -RuntimePackagePath $runtimePackage -SourceRevision $revision
```

It prepares a new immutable slot, activates it through the rollback-safe Group
supervisor, installs the source-owned Synrex Console launcher/desktop shell, and
runs the full Group readiness check. It never replaces the active slot in place.

The installed manual Console command is:

```powershell
& "$groupRoot\ops\start-synrex-console.ps1" -PlatformRoot $groupRoot
```

Installation also creates `Synrex Console.lnk` on the owner's desktop. The
launcher starts the existing `Synrex Group Core` task only when local health is
down, verifies that Windows Control on 17678 belongs to this PlatformRoot, and
then opens the desktop shell. Each PlatformRoot gets its own Electron profile.
Console session cookies are also scoped to the configured public Synrex identity,
so Group, Personal and legacy local Console sessions do not share authentication.

`Activate` requires an already prepared, authenticated-MCP-tested immutable slot.
It backs up the task XML, active pointer, config and stopped Core state, installs
the packaged supervisor and performs readiness gates. Failure restores the old
task/pointer and Group Tunnel. Old slots are retained. These code-only fixes do
not change the SQLite schema; backup state is not blindly restored over subsequent
user work. Registration checks elevation before stopping production and treats
registration errors as fatal. `Restart` reuses the installed task without copying
state or changing registration. `-LogonOnly` selects an interactive task; it still
requires elevated installation and cannot start before the user logs in.
Default S4U tasks have boot and logon triggers and retry
failures every minute. Real reboot and host-native connector results must be
reported separately from a successful task restart.

Activation performs a disk-space preflight before stopping production. The rollback
snapshot includes config, top-level SQLite/key files, diagnostics, jobs, observability,
operations and payload spool state. `devspace-state\compact-runs` is deliberately not
duplicated into every rollback snapshot: it is append-only execution history, the
activation path never replaces or deletes its live directory, and copying it can be
larger than the free space available on long-running Windows nodes. The snapshot
writes `backup-manifest.json` with the excluded path and its measured byte size.
Unknown future top-level state directories fail closed until a backup policy is added.

The supervisor records its Core PID, creation time and immutable slot. Restart
and crash recovery validate all three plus the executable/CLI before stopping
leftover Core children. A reused PID or unrelated listener is never adopted.
