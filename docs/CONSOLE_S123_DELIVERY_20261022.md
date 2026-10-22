# Console S1-S3: independent implementation and acceptance contract

Scope: improve the existing `synrex-console.service` sidecar without changing
the Synrex MCP/OAuth coordinator, runner, diagnostic collector or other coding
code. Research Harness remains separate. This version consumes the trace
contract delivered by the independent full-chain-logging workstream.

## S1 — operator visibility

- The original run list, bounded output, durable-task cancellation with strict
  workspace identity, local process tree, SSE updates and signed owner session
  remain unchanged.
- An optional `--peer-ssh gateway=gateway` (repeatable `NODE=SSH_ALIAS`) uses
  existing SSH authentication for read-only 15-second remote CPU, RAM, GPU and
  current-user process snapshots, bounded to 96 remote process rows. No new
  listener or daemon is installed on the peer. SSH requires known host keys,
  uses batch mode, and times out at four seconds. Collection never waits in the
  local SSE path. Missing/stale samples are explicitly unavailable.
- Remote processes are **read-only**. PTY/interactive cancellation remains
  unsupported until the execution owner provides verifiable persistent session
  identity; the Console must not guess by PID. Remote node health in the
  existing directory is **not** evidence of fresh resource measurements.

## S2 — view existing traces, do not collect them

- `GET /console/api/trace/:requestId` derives a bounded stage waterfall from
  existing sanitized `stage_finished` and MCP lifecycle events already held by
  the monitor. The response exposes request/trace IDs, stage/node, durations,
  offsets, status and coverage; no model-side spans or command payloads.
- Full-chain logging, event emission, any future tracing export and ChatGPT
  host observability are outside this patch. No synthetic time is assigned to
  missing stages or GPT inference.

## S3 — seven-day aggregate and comparisons

- `request_minutes` is a restart-safe SQLite materialization maintained
  transactionally with the existing request index. It migrates retained prior
  request rows once and preserves minute counts by tool/workspace even after
  bounded request-detail eviction; daily/week time charts reuse the same data.
- The request counts and error ratios come from observed minute totals.
  P50/P95 remain **exact for retained latency samples only**; the UI discloses
  available sample count. Existing diagnostic-stage samples are grouped by
  node and stage without treating stage count as whole-request throughput.
- No backfill is invented for already rotated-away diagnostics; data prior to
  the first observation is not presented as complete history.

## Boundaries, tests and release

- Console SQLite remains separate from owner-state SQLite and is the only
  database changed by this feature. Do not copy the QA stats database over the
  production monitor database; take a consistent snapshot before upgrading.
- Build only this Console's React/Vite and server artifacts. Keep cgroup CPU
  and memory limits, signed sessions, Origin checks, no shell endpoint, and
  a roll-back-ready immutable previous Console release.
- Verify focus tests, `tsc --noEmit`, Chrome GUI including S1/S2/S3 panels,
  gateway actual read-only measurement, authenticated APIs, 30-second resource
  probe, and unchanged live `devspace.service` PID/restarts.
- The current LAN HTTP listener and separate historical `/console` are
  pre-existing S0 work; HTTPS/unified entrypoint must be handled as a separate
  controlled networking change, not silently bundled into S1-S3.
