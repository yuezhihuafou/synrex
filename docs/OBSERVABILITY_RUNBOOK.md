# Synrex observability / P012 Console

This is a deployment and incident runbook, not evidence of a completed rollout.
The only out-of-scope segment is provider-owned ChatGPT reasoning and internal
server scheduling. All other phases must be recorded **where observable**,
with unknown segments shown explicitly rather than inferred from RTT.

## Observation layers and identifiers

| Layer | Source | Correlation / limitations |
|---|---|---|
| HTTP/MCP | Existing JSONL diagnostic events | requestId, callId, stage, response flush |
| Tool / peer | NodeLinkHub, WorkerClient, tool watcher | legacy traceId, nodeRequestId, callId |
| Durable tasks | per-run trace.jsonl | taskId, runId and inherited trace context |
| W3C Trace Context | requestTraceMiddleware, traceStage | otelTraceId, otelSpanId, otelParentSpanId; **JSONL metadata, not yet exported native OTel spans** |
| Runtime | startRuntimeSampler | RSS/heap/CPU, event loop/GC, active tool count; 10-second samples |
| System | separate OTel Collector hostmetrics | CPU/disk/network/PID, local bounded OTLP archive |
| TCP/Tunnel | network-observer | host TCP RTT/retrans counters and allowlisted journal events; connection-level only |
| Optional peer mirror | peer-snapshot timer on swy1 | bounded recent gateway metadata; marked stale after 2 minutes |
| Browser | owner-authenticated /console | read-only snapshots/trace lookup; no ChatGPT internal instrumentation |

Distinguish a completed tool, HTTP response flush, SSE close and actual
ChatGPT-visible completion. Unknown is a valid outcome. All nested stage
durations may overlap: compute critical paths from causality, not by summation.

## Sidecar deployment (separate from release)

See `deploy/observability/README.md` for the configuration, pinned
`otelcol-contrib` package and systemd examples. Per-node storage:

- swy1: `~/.local/share/devspace-cutover-20261018/observability`
- gateway: `~/.local/share/devspace/observability`

Each node runs `synrex-otelcol.service` and
`synrex-network-observer.service` plus `synrex-archive-index.service`,
independent of `devspace.service`.
swy1 also runs `synrex-peer-snapshot.timer` as a non-authoritative mirror.
Check with:

```sh
systemctl --user is-active synrex-otelcol.service synrex-network-observer.service
curl -fsS http://127.0.0.1:13133/
curl -fsS http://127.0.0.1:8888/metrics | grep -E '^otelcol_(receiver_refused|exporter_send_failed)'
systemctl --user status synrex-peer-snapshot.timer --no-pager
```

Each per-node `logs.otlp.json` and `metrics.otlp.json` is capped by 32 MiB
rotations with twelve backups. Retention is **up to** seven days, not a
guarantee of seven days. Diagnostic source JSONL itself has two 8 MiB files;
the Collector is responsible for accumulating available history. The
The independent `archive-indexer.mjs` consumes log/trace files using
persisted inode-and-byte offsets, keeps deduplicated allowlisted request events
and native spans for seven days in `observability/history.sqlite`, and stores
one metric sample per minute/dimension. Index retention does not depend on
the raw Collector file rotation. The Console's authenticated indexed query
supports recent/old owner events and an on-demand bounded SSH query to
gateway. Source files remain bounded; the seven-day index is distinct.
Monitor disk space, indexing lag and Collector dropped records. If the indexer
stays down beyond the raw archive rotation, reconstruction is impossible.

For browser client timing, download the opt-in Chrome extension from the
authenticated Console. Unzip, enable Developer mode in
`chrome://extensions`, choose **Load unpacked** and select that directory.
Export its local metadata-only JSON from the toolbar popup and import it in
the Console. It never collects prompts/replies, cannot see OpenAI internals,
and does not guarantee an exact tool ID correlation. Browser installation is
not remotely forced.

The producer emits standards-shaped OTLP spans over loopback HTTP
`127.0.0.1:14318/v1/traces`, buffered and bounded. A rejected exporter
increments `otelSpanDropped`; the JSONL phase events remain a separate
fallback. The arbitrary local port 4318 was already in use on swy1 and is
intentionally not overridden.

For actual independent service overhead experiments, run
`node scripts/benchmark-observability.mjs OLD_RELEASE NEW_RELEASE`.
The script compares matched loopback HTTP middleware, not model/host latency
or full MCP task completion. Collect real-node CPU/RSS, exporter drops,
application p50/p95/p99 and full-task outcomes separately.

The Collector emits process PID/name and metrics, **not command line**, owner,
executable path or process arguments. It does not collect MCP input content,
tool output or secret-bearing HTTP headers. If a deployment enabled command
line metrics before this policy, rotate its previous private archive according
to local retention needs.

## Validation before production promotion

1. Assert actual `devspace.service` ExecStart and public OAuth state have
   not changed; confirm pinned current release by manifest, not Git HEAD.
2. Build a **clean, versioned, immutable** candidate from a commit. Run
   TypeScript checks and tests covering HTTP flush, W3C context, peer routing,
   task traces, Console auth/trace lookup and redaction.
3. Run `scripts/probe-reliable-release.ts` with disposable OAuth and SQLite,
   validating real authenticated MCP, restart, Console and headless browser.
4. Benchmark active P012 + sidecar cost relative to the old pinned runtime.
5. Only with a verified owner backup, predictable rollback and a separate
   activation process, promote the pinned owner release. Promote each peer
   separately. An isolated worktree is not a deployed product feature.
6. Confirm real user-facing P012, local HTTP, public OAuth, peer route,
   collector health and deployed release fingerprints.

## Remaining limitations (must not be hidden by Console)

- An OTLP file exporter persists log records and metrics, but does not by itself
  synthesize native OTel spans from existing phase events.
- Host TCP RTT statistics are not request-specific network latency.
- The gateway mirror is capped recent metadata, not fully replicated OTLP
  history. A missing or stale mirror is not proof that gateway has no events.
- Native browser-to-server tool event correlation is not guaranteed, because
  HTTP response headers are not necessarily visible in ChatGPT's host UI.
- No actual ChatGPT reasoning, internal model scheduling or host UI spans are
  available. These intervals remain unobserved.
- Collector 0-refused and 0-export-failed counters alone do not establish
  perfect coverage: check persisted offsets, snapshots and crash/rotation tests.
