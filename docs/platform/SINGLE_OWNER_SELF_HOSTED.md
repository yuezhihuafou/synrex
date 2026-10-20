# Synrex: single-owner, self-hosted production contract

Every Synrex installation belongs to one owner. Distributing the package
means giving each user software to run against **their own** machine(s), domain,
OAuth store, and secrets. There is no shared SaaS relay, account database,
or dependency on the developer's infrastructure.

## Roles and execution locality

- **Primary host (swy1 in the current installation):** one public HTTPS MCP
  issuer, OAuth and directory state; also the default coding, ROS2, worktree,
  and durable-task execution host. The coordinator is a thin directory, not
  a mandatory separate compute service.
- **Optional peer (gateway):** local models, GPU and simulation on demand.
  No public Cloudflare connector, OAuth issuer or durable *global* state.
  Its local task/results storage remains local and is not replaced.
- **Other peer (Windows):** optional, only when available; no assumption that
  its host is online. The default install mode is standalone, not a cluster.
- Explicit node selections always override ordinary preferences where a
  placement rule does not *require* a host. Existing workspace/task routes
  remain bound to their original execution node.

The primary host must be usable while every optional peer is offline.

## Authentication and security boundary

- Preserve MCP OAuth/PKCE for host compatibility. There is exactly one owner,
  not a team/multi-tenant permission system.
- Existing registered clients can reauthorize using the Owner password while
  *new* client registration is closed. A previously approved, short-lived
  authorization code remains exchangeable if the window closes.
- Access tokens are short-lived, refresh tokens rotate and survive restarts.
  Credential/issuer/database continuity matters more than long access-token
  TTLs. Never solve reconnect failures by disabling bearer authorization.
- Do not expose the local shell or SSH to the public internet. The MCP server
  binds to loopback; Cloudflare provides HTTPS. Keep only one public authority
  for a domain, and deny unauthorized MCP calls.
- Recovery stays possible from a local SSH session using the installed
  `devspace-auth-admin` command. `/oauth/recovery` requires the Owner password;
  neither route authorizes general MCP access without tokens.
- Private node communication should use a private network or authenticated
  outbound relay. Node bearer credentials are *not* the user's OAuth tokens.

## Durability and upgrades

- Run the primary service and tunnel with systemd user services and lingering.
  Restart failures automatically, but do not start an independent OAuth
  server on a compute peer as a health-check fallback.
- Keep SQLite, replay key and owner credentials outside compiled releases.
  Take SQLite online snapshots including WAL transactions, with owner-only
  filesystem permissions, before upgrades and on a daily timer.
- Verify local runtime, database integrity and public OAuth discovery on a
  separate read-only health timer. Never rotate an existing OAuth grant as a
  monitoring probe or restart a service on an external network-only failure.
- Keep historical run logs separately. Log archives are best-effort snapshots;
  currently executing processes and external model data need independent
  checkpoint/storage policies.
- A release is immutable, contains all runtime assets, retains the public
  issuer and client credentials, and supports a tested rollback. Never use a
  dirty worktree's `pnpm deploy:live` against an already pinned coordinator.
- Test restart + refresh, authenticated MCP, an optional peer offline, and
  recovery before switching production. Do not create synthetic OAuth clients
  in the production store for a monitoring probe.

Continuous uptime cannot be guaranteed during power/internet outages.
No periodic manual token reenrollment should be required during normal operation.
