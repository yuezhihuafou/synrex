# Independent Console P0–P2

This console is an additive sidecar. It does not change or import the MCP server
entrypoint, restart `devspace.service`, migrate its state, or replace the existing
`/console`. All new source lives on the isolated `console-monitor-p012` branch.
Research Harness remains a separate project.

## Delivered behavior

- P0: live snapshots plus SSE patches; automatic reconnect, snapshot reconciliation
  and polling fallback; pause and background suspension; local CPU, memory, GPU,
  current-user processes, durable executions and parent/child PID relationships.
- P1: execution details, bounded output following, correlated diagnostic events,
  filtering/export, explicit cancellation of durable tasks in exact configured
  workspaces, idempotency receipts, workflow handoff and existing node directory.
- P2: independent restart-safe SQLite statistics, incremental diagnostic import,
  rotation deduplication, HTTP latency P50/P95, tool-error-aware request outcomes,
  task completion/failure/cancellation counts and time/tool/workspace filters.

## Important scope

Resources and cancellable executions are local to the monitored node. The node
directory can show gateway/Windows status and build compatibility, but it does
not invent remote process/GPU measurements. Live interactive/PTY sessions do not
persist their session identity/PID in the existing core. Their OS processes can
be viewed, and finished runs can be inspected; this sidecar deliberately cannot
terminate them by guessing a PID or session handle. No core hook was added.

Request success is not engineering-goal acceptance. Host/model reasoning time,
token usage and billing are unavailable. Observed statistics are bounded retained
data, not a claim of complete historic coverage; rotated-away logs cannot be
reconstructed. The initial run backfill scans at most 600 recent/active records.

## Lightweight limits

No new package dependency, agent loop or runtime platform. The browser uses existing React.
The backend reuses existing session signing, run metadata and cancellation.
Production SQLite files are opened read-only; all monitor writes go to a separate
monitor directory. Only an explicit cancel action writes the existing runner's
cancellation marker/terminates its verified execution unit.

- A single non-overlapping sampler; 5 seconds with viewers, 30 seconds idle.
- GPU command at most once per 30 seconds, with a 1.2-second timeout.
- Up to 1,024 same-user processes; at most 600 run records per scan; terminal
  records cached. Live UI lists 120 records, with 300-character command summaries;
  complete command/output loads on demand.
- SSE sends one full snapshot then changed execution rows and resource updates.
  At most four streams; backpressure drops intermediate updates and the next
  update reconciles against the last accepted revision. Reconnect starts fresh.
- Output reads only the last 64 KiB; no full-file output reads.
- Diagnostics read new bytes only, at most 2 MiB per source file per collection.
  Seven-day / 20,000-row retained history per table; 1,000 operation receipts.
  SQLite is capped at 32 MiB plus bounded WAL; failures do not reach the core.
- Suggested systemd isolation: Nice=10, CPUQuota=10%, MemoryMax=256M, TasksMax=32.

## Build and start

```bash
pnpm exec vite build --config vite.console.config.ts
pnpm exec vite build --config vite.console-server.config.ts
node dist-console-server/console-monitor.js \
  --state-dir /path/to/existing/state \
  --run-root /path/to/existing/runs \
  --monitor-dir /path/to/separate/monitor-state \
  --auth-file /path/to/existing/auth.json \
  --port 4318 --host 127.0.0.1 \
  --origin http://127.0.0.1:4318
```

The existing Owner password is read without changing the auth file. No OAuth
authority, writable production database or MCP listener is created. Add
`--write-root /exact/canonical/workspace` for each workspace whose durable tasks
the owner should be able to cancel. The default is read-only. Multiple exact
`--origin` values support explicitly configured LAN/HTTPS endpoints. Credentials
remain in HTTP-only session cookies and are not saved to browser local storage.

Package the two output directories, package.json and pinned dependencies into a
new monitor-only release directory. Run it under its own systemd unit. Stopping
that unit stops the monitor only; rollback never requires restarting Synrex.

## Verification

```bash
pnpm exec tsx --test src/console-monitor/monitor.test.ts \
  src/console-router.test.ts src/console-snapshot.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsx scripts/console-monitor-browser-qa.ts \
  http://127.0.0.1:4318/console/ /path/to/auth.json /tmp/console-qa
pnpm exec tsx scripts/console-monitor-probe.ts \
  http://127.0.0.1:4318 /path/to/auth.json monitor-unit.service
```

The browser QA uses temporary headless Chrome and its native DevTools protocol;
no browser-testing dependency is installed. It checks login, SSE, navigation,
details/output, and mobile overflow. The overhead probe reports actual elapsed
time, cgroup CPU/memory and response sizes; it does not estimate model time.
