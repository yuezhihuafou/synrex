# DevSpace swy1 coordinator cutover — verified production

2026-10-19 update: the owner-persistent production release is now
`20261019-owner-persistent-v1`. It keeps the original issuer, SQLite and
MCP tool contracts. The existing OAuth clients can reauthorize through an
Owner-password approval while new registrations remain locked, and an already
approved authorization code can finish exchanging after a window closes.
The `swy1` production placement preferences for `/home/swy/DevSpace`,
`/home/swy/ros2_ws`, `/home/swy` and `~` select swy1 by default; an explicit
gateway selection remains possible. Existing global workspace/task IDs are
unchanged. Verified private online SQLite snapshots go to
`~/.local/share/devspace-owner-backups/`; the daily backup timer includes
best-effort run log archives, and a separate health timer performs read-only
integrity/local/public probes every 15 minutes. The previous complete release
is retained for rollback. See `SINGLE_OWNER_SELF_HOSTED.md` for the supported
single-owner distribution model.

Original cutover: 2026-10-18, approximately 14:10 CST (UTC+08:00).

Recovery correction later that day: gateway's legacy watchdog had restarted its
Cloudflare connector, restoring two public backends with independent OAuth state.
The watchdog timer and old connector are now disabled, and the connector has an
explicit `ConditionHost=swy1` guard. One missing active refresh record was merged
additively after client compatibility and replay checks; existing records and keys
were retained. Core migration also exposed a local global/local workspace-ID
translation bug; the routing hotfix preserves both workspace and task identities.
The corrected release is `20261018-auth-three-node-recovery`. The production
runtime has 13 advertised MCP tools; gateway may expose additional local capabilities.
Windows remains registered but offline; a Windows SSH endpoint was discovered at
192.168.5.203, but both Linux hosts' keys were rejected for user shaky. Its identity,
PowerShell/WSL state and current runtime cannot be verified without Windows access.
Do not interpret this document's older cutover success as proof of Windows recovery.

Current evidence and restricted backups are under
`~/.local/share/devspace-recovery/20261018-auth-three-node/` on both Linux machines.
Runtime rollback preserves the live database and never re-enables gateway ingress.


## Stable deployment

| Host | Public ingress | Local DevSpace | Outbound node relay |
| --- | --- | --- | --- |
| swy1 | Cloudflare, enabled | coordinator at 127.0.0.1:7676, enabled | none required |
| gateway | Cloudflare disabled | full peer at 127.0.0.1:7676, enabled | persistent SSH 127.0.0.1:7678 -> swy1:7676 |
| win-laptop | none | full Windows runtime, when laptop is online | existing HTTPS public domain |

The domain `https://devspace.yuezhihuafou.dpdns.org` and OAuth
issuer/resource identifier were retained. The gateway and swy1 production
node identities stayed stable, including all previously issued workspace
and task routes. The Windows node was **offline** during final verification
and has not yet been observed reconnecting after the cutover.

## On-disk authority

- swy1 `devspace.service` launches
  `/home/swy/services/devspace/releases/20261018-auth-three-node-recovery/dist/cli.js`.
  Its config is `/home/swy/.devspace-cutover-20261018` and authoritative
  SQLite is `/home/swy/.local/share/devspace-cutover-20261018/devspace.sqlite`.
- Full runtime package assets, including `skills/subagents/SKILL.md`, are
  pinned inside the release. The mutable robot checkout at
  `/home/swy/DevSpace` is not automatically the production runtime.
- gateway now runs `cluster.role=peer` with the old production execution
  state, without replacing its local workspace sessions or durable results.
  Its `cluster.gatewayUrl=http://127.0.0.1:7678` uses the already-enabled
  `devspace-swy1-lan-tunnel.service`, not a temporary SSH process.
- Only swy1's Cloudflare user service is both enabled and active. gateway
  Cloudflare is disabled and inactive. The obsolete swy1
  `devspace-core.service` and `devspace-gateway-lan-tunnel.service` are
  disabled. The original configurations and user units are backed up.

## Data merge rule

Do **not** union local `workspace_sessions` or
`workspace_conversation_bindings` across machines: they can have the same
conversation keys with different local sessions (20 real collisions were
found). The final migration began with a consistent gateway production
snapshot for **global** OAuth, node, workspace and task routes, then
replaced only local execution tables with the swy1-local runtime's records.

The final candidate retained the prior 82 global workspace routes and
its task routes, preserved OAuth and refresh-token identities, resolved
all 24 swy1-owned global workspace routes to swy1 local sessions, and
passed SQLite integrity/foreign-key tests. Subsequent calls added routes.

## End-to-end evidence

1. Private coordinator bearer-token authentication and MCP tools/list
   succeeded, advertising 15 real registered tools including coding and
   Research Harness.
2. Both the original gateway and swy1 global workspace IDs completed
   `read` and `exec_command` via the candidate.
3. The first live attempt failed at immediate health polling during
   service startup; the automated rollback **restored gateway ingress**.
4. The corrected attempt used bounded readiness loops and completed.
   An existing ChatGPT DevSpace connection then executed a real tool call
   through swy1's new public endpoint.
5. Acknowledgement records were created on **both** hosts and rollback
   timers canceled. Gateway was permanently switched from the temporary
   private 7682 link to the original enabled 7678 SSH service.
6. The gateway old Cloudflare connector was stopped and disabled, and
   swy1's enabled. Public HTTPS health returned 200 (~1.09 seconds in
   one sample). After the cutover, the swy1 authority had 82 workspace
   routes and 1,056 task routes, no SQLite FK violations, and only active
   OAuth access tokens (refresh tokens retained).

These are tested properties, not a guarantee of uninterrupted availability
through every future network or host outage.

## Recovery and maintenance

- Restricted saved unit/config/auth backups are held on each Linux host
  under `~/.local/share/devspace-refactor-backups/peer-cutover-20261018/service-rollback/`.
  The cutover directory includes pre- and post-freeze database snapshots
  and merge audit reports. Keep them until separate retention approval.
- `deploy/rollback-peer-cutover-{gateway,swy1}.sh` are **emergency**
  scripts from the migration; a future planned reverse cutover needs a
  NEW consistent database snapshot. Never roll back across a long period
  and assume newly created task routes/OAuth state will follow automatically.
- Do not enable gateway Cloudflare concurrently with swy1 Cloudflare.
- Do not use `pnpm deploy:live` from the swy1 checkout to replace the
  pinned production coordinator: the source checkouts have different
  Research Harness/knowledge tool inventories. Build a complete verified
  release and compare tool contracts first.
- When Windows comes online, confirm it joins the swy1 authority without
  changing its node ID or credentials. It already runs the upgraded
  `runtime-peer-20261018` build.
