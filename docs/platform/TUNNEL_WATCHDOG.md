# Optional Linux Cloudflare Tunnel watchdog

This is an operational companion to Synrex, not a prerequisite for Coding or
for the cross-platform portable installer. It must be enabled only on the
**single public Owner host**, never on an optional Windows or GPU peer.

The oneshot observer `deploy/observability/tunnel-guard.mjs` checks the
existing local ingress and a Cloudflare metric
`cloudflared_tunnel_ha_connections` at a loopback-only metrics endpoint.
Missing metrics or an unavailable ingress do not authorize restarts.
When the ingress remains reachable but Cloudflare reports zero connections,
the observer also checks general outbound HTTPS reachability. It requires
three consecutive qualifying checks, has a ten-minute cooldown, and permits
at most three restart attempts per hour. It never changes MCP/OAuth state.
The service/timer files are examples for user-level systemd; replace the
Node executable with the installed absolute path before enabling.

The unit name defaults to `cloudflared-devspace.service` for compatibility.
Do not run a second Tunnel or an independent OAuth coordinator as a fallback.
Observer records are private, bounded JSONL under
`~/.local/share/synrex-observability/tunnel-guard/`.
Run `node --test deploy/observability/tunnel-guard.test.mjs` to exercise
the failure threshold, cooldown and recovery without touching any services.

This guard is not a cure for WAN outages, DNS failures, power loss, OAuth
problems or Cloudflare incidents. In those cases diagnose the failing layer;
do not automate repeated service restarts.
