# Independent Console: Cloudflare Tunnel recovery events

The independent Console consumes the local, bounded, allowlisted
`~/.local/share/synrex-observability/tunnel-guard/events.jsonl` and its
single rotated predecessor. This input is written by the separate
`synrex-tunnel-guard.timer` and never gives Console control over systemd.

The collector attaches a read-only `tunnelRecovery` section to its existing
authenticated `/console/api/snapshot` and SSE updates. The existing
**日志与链路** view displays the 24-hour count of degraded/failed checks,
successful and failed restart commands, observed recoveries, and the sum of
closed observed outage durations. A timestamped incident timeline is retained
for up to seven days, subject to bounded file rotation. Unpaired incidents
show an unknown end time and do not contribute to completed-duration totals.

The latest positive `tunnel_guard_sample` indicates how many Cloudflare
connections existed at that observation time, **not** a continuous live
guarantee. A missing source, truncated logs, and stale samples must be
distinguished from zero failures. This is a local, non-authoritative display:
MCP/OAuth ownership, Cloudflare recovery policy and guard cooldowns remain
outside Console. Do not change them from this UI.

The first historical outage on 2026-11-11 predates this event producer;
its precise detection/repair interval is recorded separately in
`docs/TUNNEL_RECOVERY.md` on the main development checkout. Do not backfill
fictitious recovery counters from a journal estimate.
