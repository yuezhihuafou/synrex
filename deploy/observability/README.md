# Synrex observability sidecar (isolated candidate)

The Console remains the independent browser-based React/Vite `/console` page.
The production MCP ingress must never depend on this collector or its storage.

1. On swy1 the **verified** production diagnostics root is
   `/home/swy/.local/share/devspace-cutover-20261018` (not the config root).
   On gateway, discover the actual runtime state directory before deployment.
   `diagnostics/recent.jsonl` rotates to `.1` and is not historical storage.
2. Install a pinned `otelcol-contrib` build per peer, with a dedicated user
   service. Validate the configuration against that binary before starting.
   Copy the config to `~/.config/synrex-observability/collector.yaml` and
   service to `~/.config/systemd/user/synrex-otelcol.service`. For swy1 set:

   ```text
   SYNREX_STATE_DIR=/home/swy/.local/share/devspace-cutover-20261018
   SYNREX_NODE_ID=swy1
   SYNREX_OTEL_ROOT=/home/swy/.local/share/devspace-cutover-20261018/observability
   ```

   Place these in `~/.config/synrex-observability/collector.env` (mode 0600).
   Create the `offsets` and `data` directories, mode 0700, before starting.
   The file exporter writes local JSONL OTLP logs and metrics with bounded
   rotation; no network ingestion endpoint or remote exporter is enabled.
4. Monitor Collector memory, dropped events, offset recovery, exporter backlog
   and disk quota. Verify restart and rotation behavior with synthetic logs.
5. Preserve the original request/call/task/run IDs as attributes. Existing
   `traceId` may be a UUID, **not** an OTel-compatible 32-hex trace ID. Never
   interpret the old field as a standard distributed trace without mapping.
6. Deploy separately on swy1 and gateway; gateway being offline must not
   block swy1. Capture network and tunnel health from locally accessible
   metrics/journal events without logging secrets or HTTP bodies.

This example retains bounded OTLP history on each peer, but **does not yet
provide** a cross-peer unified searchable index, connection-specific RTT,
browser association, nor conversion of Synrex diagnostic events into exported
OTel spans. Those require separate validated integrations. Never claim
end-to-end coverage merely because a Collector starts.

### Gateway metadata mirror for the owner Console

Install `peer-snapshot.mjs` under `~/.local/share/synrex-observability/`
and the two `synrex-peer-snapshot.*.example` units under
`~/.config/systemd/user/` on **swy1 only**, stripping the `.example` suffix.
Enable `synrex-peer-snapshot.timer`; it reads a capped 600-line window of
allowlisted diagnostics and network samples over the preexisting SSH alias
`gateway` once a minute. Local snapshots are metadata-only and written
atomically; failure does not stop MCP or Collector. Console marks the mirror
stale after 120 seconds. This is **not** replication of gateway's authoritative
retained OTLP archive. Recover older peer history from the peer itself.

The network observer reads only aggregated established TCP RTT samples and
host-wide retransmissions. Do not interpret these as exact one-request network
latency. Collector itself exposes internal counters on loopback port 8888,
with refused/export-failed counters observed by the independent network
observer and published to the same bounded JSONL. A zero counter is not proof
of zero end-to-end data loss; verify file offsets and backups separately.
