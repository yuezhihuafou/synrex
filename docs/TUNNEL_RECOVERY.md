# Synrex Cloudflare Tunnel recovery contract

Incident: 2026-11-11. `devspace.service` and `synrex-ingress.service` stayed alive; `cloudflared_tunnel_ha_connections` reached zero after upstream network disruption. Logs show edge disconnects (12:03), DNS/edge-address and TLS handshake failures (14:02), then Tunnel service restart (14:04:27), followed by two registered connections (14:04:28–29). A correlation with the earlier USB Ethernet failure exists but the precise network root cause is not independently established.

## Ownership and failure layers

- `swy1` remains the sole authoritative MCP/OAuth owner. The active pinned production release is selected by `devspace.service`, not mutable source.
- `synrex-ingress.service` serves local 7676 and forwards to the production coordinator on 7677; root HTTP 404 is not itself an outage.
- `cloudflared-devspace.service` owns the public tunnel (metrics on 127.0.0.1:20241). Its existing `Restart=always` recovers crashed processes but not all still-running, disconnected processes.
- synrex-tunnel-guard.timer checks active Cloudflare connections every 60 seconds without touching the MCP owner or ingress. After 3 consecutive zero-HA checks and healthy local ingress, it requests a nonblocking restart, subject to 10-minute cooldown and a maximum of 3 attempts per hour. The general HTTPS WAN probe is diagnostic only: proxy/Fake-IP interference cannot indefinitely veto rate-limited recovery. Missing local ingress or HA metrics still produces diagnostics without a restart.
- Guard events go to `~/.local/share/synrex-observability/tunnel-guard/events.jsonl` and can be correlated with `network.jsonl` and journal entries by timestamp. No URLs, tokens or raw response contents are logged.

## Operations

Check `systemctl --user status cloudflared-devspace.service synrex-tunnel-guard.timer` and `curl -fsS http://127.0.0.1:20241/metrics | grep '^cloudflared_tunnel_ha_connections '`. Inspect `journalctl --user -u cloudflared-devspace.service` and guard events before intervening. Explicit manual recovery: `systemctl --user restart cloudflared-devspace.service`. If the WAN itself is down, repair that first; do not restart owner services or run a second tunnel instance.

Source of guard code is deploy/observability/tunnel-guard.mjs; deployment is separate from the immutable MCP Core. Simulated failure, WAN-probe-unavailable, cooldown, and live zero-impact verification are required. Prefer QUIC while UDP/7844 is available and TCP/7844 HTTP/2 fails. A positive local HA count does not establish public hostname routing; independently probe the public MCP URL externally.

## Console integration (2026-11-11)

The existing independent `synrex-console.service` now uses the pinned release
`/home/swy/services/synrex-console/releases/20261111-tunnel-console-65a09df`
(source commit `65a09df14a4d0a7f50e45ac003be001e4061ab8b`, based on the previously
active Console commit `00f1662`). The authenticated Console **日志与链路** page
reads the guard JSONL via its existing read-only snapshot/SSE collector. It
displays 24-hour detection/restart/recovery counts, per-incident observed
duration and bounded event history. The live producer now emits 60-second
`tunnel_guard_sample` connection counts and a recovered event after an outage;
older faults predating guard deployment are not invented.

Production Console unit override:
`~/.config/systemd/user/synrex-console.service.d/90-tunnel-events.conf`.
The old Console failed to restart during the cutover because its startup
arguments included the removed worktree
`~/.devspace/worktrees/DevSpace-886bad07`. The override drops only that
stale `--write-root`, preserving `/home/swy/DevSpace`, OAuth-related settings,
external origins, port 4318, and the gateway peer. This was a *Console startup
dependency issue*, not a Synrex MCP outage.

Rollback: copy
`/home/swy/services/synrex-console/backups/20261111-rollback-valid-root.conf`
over the current `90-tunnel-events.conf`, run
`systemctl --user daemon-reload && systemctl --user restart synrex-console.service`,
then verify `/health` and authenticated `/console/api/snapshot`. Do not simply
remove the override: older drop-ins still reference the deleted worktree.
The MCP owner and Tunnel are not part of Console rollback.
