# Concurrent ChatGPT incident: agent workspace permission and reply-stream evidence

On 2026-10-27 at about 15:52 CST an ordinary ChatGPT conversation displayed
"连接已中断，正在等待完整答复". Multiple conversations were working on Synrex.
The screenshot establishes an interrupted **ChatGPT reply stream**, not an
identified Synrex Core restart or subagent execution failure.

## Verified at the time of the incident

- Actual pinned production Core remained `2b0ffcfe97f0`; the swy1
  `devspace.service` and independent `synrex-ingress.service` retained their
  existing PIDs and loopback port ownership (7677/7676). Cloudflare was active.
- Diagnostic MCP requests between 15:49 and 15:52 returned HTTP 200. No
  early-closed Synrex MCP request was observed in that window. Two local
  `exec_command` invocations exited nonzero at 15:51:53 and 15:52:24
  (`errorCategory=command_exit`); those were development commands. Synrex's
  `processToolResponse` deliberately returns `isError: true` on nonzero
  exit, and the ChatGPT tool bridge can surface this as an outer error. This
  **does not prove** the remote ChatGPT model or browser-stream disconnect
  was caused by the tool result; the host's private stream is not observable
  in these server logs.
- The registered Core Shell/structured-edit concurrency gate does **not**
  serialize arbitrary concurrent Shell writes in the same checkout. Isolated
  Git worktrees are the supported independent multi-conversation write path.
- Managed worktrees have their own trusted registered `workspaceId`, a
  distinct filesystem root, and an allowed original source repository. The
  pre-fix subagent CLI and Agent Daemon only checked `allowedRoots`, so
  `synrex agents targets --json` from a managed worktree failed with
  `Path is outside allowed roots`. In an unscoped original checkout, provider
  targets `codex` and `antigravity` were present. This was a **real
  authorization inconsistency** rather than deleted agent provider code.

## Source correction and privileges

- The agent CLI and daemon now authorize **only** exact active registered
  managed worktree `id + root + source_root` associations, using a
  **read-only** lookup of the owner workspace directory SQLite store.
  The canonical original source must still satisfy `allowedRoots`, and the
  worktree must be inside `worktreeRoot`. Unknown/expired/pruned IDs and
  forged paths remain denied; arbitrary paths merely under `worktreeRoot`
  never gain access.
- The CLI's `agents targets/list/run/show/continue/events/stats/watch/context`
  and `show-changes` use the same authorization; the daemon independently
  verifies the scope, rather than trusting the client.
- Preserve MCP nonzero-command failure receipts and explicit exit status;
  do not blindly relabel failed commands as successful to work around the
  host-specific tool bridge. Handle *expected* exit codes in ChatGPT
  orchestration with explicit status reporting instead of leaking an
  unhandled outer exception.
- No second reasoning agent, new credential authority, broad
  `allowedRoots`, or loss of worktree isolation is introduced.

## Separate production Console drift

Independently, the 15-second out-of-process Console snapshot collector was
still configured for immutable `20261026-synrex-usage-e9114fb`, whereas
Core had already advanced to `synrex-main-2b0ffcfe97f0`.
The independently managed collector's stale release drop-in was corrected
under the owner release lock; **only the snapshot service was restarted**.
The resulting cached snapshot reported `synrex-main-2b0ffcfe97f0` and a
present `dataFreshness` section. The old configuration was retained in
`~/.local/state/synrex/console-hotfix-20261027T080628Z`.
This did not repair or restart the ChatGPT reply stream.

## Delivery limitations

The user requested **no test-suite execution** during this incident.
Do not claim the source permission correction is deployed until the immutable
new release and its independently spawned Agent Daemon actually use it.
The existing guarded owner promotion deliberately requires regression and
authenticated protocol checks; never bypass those gates or overwrite the
newer pinned Core merely to accelerate a hotfix.
