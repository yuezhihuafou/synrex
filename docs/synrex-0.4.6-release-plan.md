# Synrex 0.4.6 — consolidation and deployment hardening

## Scope and source provenance

- Canonical source: yuezhihuafou/synrex main, base a29bda08 (0.4.5).
- Implemented exclusively in a new Gateway checkout; no live development,
  coordinator, peer, Windows scheduled task, or swy1 production service modified.
- Retain the existing 0.4.5 host administration, task continuity, remote peer
  delivery/receipts, standalone CLI, multi-node management, local agents,
  observability, review cards, website and installer capabilities.
- Gateway's older immutable canary (source 77b10c6e) was compared against main.
  Its source differences are not a replacement for the canonical 0.4.5 base.

## State/concurrency fixes

1. Durable Task: per-task cross-process state lock and conditional
   reconciliation, monotonic terminal state and unique atomic temp names.
2. Durable Task: cancellation check immediately before spawn, fresh PID
   lookup when cancellation is requested, and ambiguous systemd-run fallback
   fails closed instead of risking duplicate command execution.
3. PTY: per-session serialized write/resize/poll/output consumption.
4. PTY shutdown: SIGTERM grace, SIGKILL escalation, wait for logger exit.
5. Worker: global execution semaphore independent of reconnect/poller epoch.
6. Node registration: preserve operator-set draining across reconnect.
7. Workspace: rollback newly created Git worktrees when bootstrap fails;
   persist workspace sessions only after context bootstraps.
8. Workspace GC: honor active durable-task markers even if workflow is done,
   and permit safe recovery of dead lifecycle lock owner.
9. Retention GC: do not treat early meta.json write as terminal task commit.
10. ACP: reserve resumed session before asynchronous configuration.
11. Daemon: single-flight start/close with in-flight requestId de-duplication.
12. Workflow: correct sliding binding renewal threshold.
13. Portable Windows service files: explicit backup/refresh upgrade path,
    preserving default refusal to overwrite customized launchers.

## Intentional concurrency boundaries

- Long-running shell commands are intentionally detached from the tool-call
  workspace gate; worktrees isolate simultaneous modifying workflows.
- A fresh logical command ID is not guessed to be a retry: command equality
  cannot safely distinguish a retry from an intentional second execution.
  Callers must reuse stable request IDs to obtain at-most-once behavior.
- Destructive GC remains fail-closed when ownership cannot be established.
  The new recovery path requires a stale marker and a dead owner.

## Deployment and compatibility

- Never replace live binaries or mutable state with a checkout.
- Linux: inspect active systemd unit, release manifest sourceRevision, tunnel,
  health endpoint and peer registry before promoting an immutable build.
- Windows: run the read-only deploy/upgrade-preflight.ps1 to identify legacy
  DevSpace.WinLaptop/Synrex.Portable tasks and the port 7676 owner. Do not
  register a second service against an occupied port.
- Stage verified portable 0.4.6 release first. After activation, regenerate
  service launchers using portable-service.mjs --write --upgrade (backs up
  existing files); switch tasks only in a separate, approved deployment step.
- Preserve existing configuration, state directories, OAuth files, peer
  identities, Cloudflare tunnel settings, and node join tokens.
- Mixed-version peers require explicit protocol/contract compatibility checks.
  An older peer must not be overwritten merely to satisfy a version label.
- On failure: revert immutable release pointer/service target and read health
  and logs before attempting again. Never delete user data as rollback.

## Release acceptance

- TypeScript typecheck and production build.
- One project test-suite run (including portable installer/service tests).
- Verify package version, dependency lock and portable artifacts.
- Inspect scoped diff, ensure no credentials/state files, and confirm main
  ancestry and source revision before publishing.
- A v0.4.6 tag is only created for a verified, green release commit; Git push
  alone does not deploy or activate a service.
