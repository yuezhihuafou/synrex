# Windows Group startup and recovery

The packaged `deploy/windows/group-service.ps1` owns the existing `Synrex Group Core`
scheduled task. It starts the active slot's Core, waits for localhost health,
starts only Group Tunnel `edbf2dd7-2cc1-434c-979a-2f6b387eebe3` with HTTP/2 and
`--token-file`, then verifies Tunnel readiness, origin/public health, local/public
MCP 401 challenges, OAuth resource metadata and Console. Qwen is never selected by
executable name alone. Occupied ports fail closed. A named mutex prevents duplicate
supervisors; an exited Tunnel is restarted, and a failed Core is recovered by the
scheduled task. No token value is passed to a command or written to logs.

Run PowerShell as the owner, elevated for installation or activation:

```powershell
& .\deploy\windows\group-service.ps1 -Action Activate -PlatformRoot $groupRoot -SlotName $verifiedCandidate
& .\deploy\windows\group-service.ps1 -Action Restart -PlatformRoot $groupRoot
& .\deploy\windows\group-service.ps1 -Action Check -PlatformRoot $groupRoot
```

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
