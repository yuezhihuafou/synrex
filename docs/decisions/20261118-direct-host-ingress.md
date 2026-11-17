# Independent Synrex host connections and SSH rescue

Decision date: 2026-11-18. Requested production direction: each machine is
independently reachable by ChatGPT; no default dependency on another machine's
MCP coordinator. Preserve existing client access until direct replacement
connections pass real authenticated host-to-tool tests.

## Incident evidence

- During the November 17-18 incident, swy1 Core and local ingress served HTTP,
  but its Cloudflare public hostname returned 1033. Forced HTTP/2 encountered
  TLS edge EOF and TCP precheck failures; QUIC passed UDP checks.
- The old swy1 tunnel guard cleared failure counts when a generic HTTPS probe
  failed, allowing repeated zero-HA periods without a bounded restart attempt.
- Meta/Fake-IP DNS returned 198.18/15 addresses for some public names, so
  a self-probe from swy1 alone was not authoritative for external reachability.
- Windows and swy1 local SSH now work in both directions using verified host
  fingerprints and separate LAN paths.

## Decision

1. Keep the working swy1 OAuth issuer, pinned Core, database and Cloudflare
   Tunnel unchanged. The Cloudflare transport override uses QUIC. The isolated
   observability guard receives bounded, nonblocking recovery improvements.
2. Add a separate Windows standalone Synrex runtime: own config, state, OAuth
   secret, and loopback endpoint 127.0.0.1:7678. Do not copy swy1 OAuth keys
   or SQLite state. Preserve the old Windows peer on :7676 for rollback.
3. Give Windows its own durable public HTTPS ingress and issuer hostname,
   independent of swy1. Acceptable implementations include a separately
   authorized Cloudflare Tunnel or Tailscale Funnel. Do not reuse swy1's
   Cloudflare Tunnel token, hostname or ingress as a purported independent
   path. No direct raw public port or unauthenticated shell access.
4. Register two separate ChatGPT MCP connections, each using its own URL and
   OAuth authorization. Select the desired host explicitly. A host outage
   must not prevent the other host's standalone MCP tools from functioning.
5. Preserve strictly verified, batch-mode SSH aliases in both directions for
   emergency recovery on the local network. Never disable host-key checking.
   Retain a user-controlled out-of-band remote desktop/terminal path.

## Verification status at decision time

- swy1: pinned Core and ingress healthy; cloudflared has four connections;
  Windows independently sees public MCP HTTP 401.
- Windows: separate localhost standalone and its own scheduled task running;
  local port 7678 returns HTTP 401; original port 7676 remains listening.
- Windows to swy1: SSH executed hostname, returning swy1.
- swy1 to Windows: SSH executed hostname, returning swy.
- Windows public independent HTTPS and ChatGPT's *second* direct MCP
  registration are **not yet complete**. Tailscale CLI is installed but
  BackendState is NoState; there is no Windows Cloudflare Tunnel credential.
  Do not claim the gateway dependency has been fully removed until that
  separately authenticated end-to-end path is verified.

## Rollback and operations

- The swy1 live guard was backed up before replacement, separately from the
  pinned production Core. Undo only the guard script if it fails verification.
- The Windows standalone uses an additive Synrex.WinDirect task and isolated
  local state. Disable this task/instance if needed without touching the old
  DevSpace.WinLaptop worker or swy1 OAuth identity.
- Do not disable old peer routing until both independent ingress connections
  have passed actual ChatGPT tool execution and host-down recovery checks.
- Public monitoring on Windows is best effort when Windows is online; the
  local swy1 guard remains responsible for its own process recovery.
