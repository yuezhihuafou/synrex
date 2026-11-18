# Synrex owner operations (PC and swy1)

The two deployed MCP identities are deliberately independent:

- swy1 remains the current public OAuth coordinator with a stable ingress
  proxy. Only its existing ingress-aware `deploy/activate-owner-release.sh`
  and `deploy/request-owner-rollback.sh` may switch swy1's core release.
- PC has both a multi-host execution peer on :7676 and a standalone OAuth
  owner on :8686. `standalone-release.py` operates **only** the standalone
  `synrex-owner.service`, never the peer or the swy1 coordinator.

## Recurring maintenance

Both owner installations use the existing `backup-owner-state.py` for SQLite
online snapshots including WAL, private OAuth/config files, and optional run
logs. Keep 14 completed snapshots, stored outside the live state directory,
under owner-only permissions. A daily systemd user timer triggers the backup.

Run `owner-guard.py` every 15 minutes as a separate user timer. The guard is
read-only: it checks systemd services, the live database, the latest backup
(must be within 48 hours), the pinned release's critical asset hashes, the
local health endpoint, the HTTPS OAuth issuer, and the protected MCP resource.
It may retry a transient read once. A failed health probe must be visible in
`systemctl --user status ...-health.service` and journal, **not** trigger a
restart or token renewal. Check status before treating one network failure as
server failure.

## PC candidate lifecycle

The PC runtime is pinned to an absolute, immutable release directory via
`synrex-owner.service.d/20-pinned-runtime.conf`. The separate peer uses a
different service, state, OAuth credentials, and run-root.

After a clean, tested package has been staged under
`/home/pc/services/synrex-owner/releases/<release-name>` with its complete
`release-manifest.json`, run:

```bash
python3 /home/pc/services/synrex-owner/ops/standalone-release.py status
python3 /home/pc/services/synrex-owner/ops/standalone-release.py verify /home/pc/services/synrex-owner/releases/<release-name>
```

The candidate must have verified QA, an unmodified file manifest, clean build
provenance, and `previousRelease` matching the **currently active** release.
The tool does not build from a dirty checkout, automatically follow remote
`main`, or pretend that staging a package means it was promoted.

For activation, run the switcher in a separate user-managed unit, not within
the MCP Core process being restarted:

```bash
systemd-run --user --collect --unit=synrex-owner-promote-$(date +%s) \
  /usr/bin/python3 /home/pc/services/synrex-owner/ops/standalone-release.py \
  activate /home/pc/services/synrex-owner/releases/<release-name>
```

The switcher acquires a lock, rechecks manifest hashes, takes an online owner
backup, writes a private pre-switch drop-in, switches the pinned service,
checks local health and public OAuth issuer, verifies the peer is still active,
and restores the prior pinned service automatically on failure. Receipts live
in `~/.local/share/synrex-owner-rollouts/`.

After an upgrade, an explicitly requested rollback uses:

```bash
systemd-run --user --collect --unit=synrex-owner-rollback-$(date +%s) \
  /usr/bin/python3 /home/pc/services/synrex-owner/ops/standalone-release.py rollback
```

Rollback requires the new active manifest to name a still-installed,
verified previous release. The initial PC build has no previous release
installed, so rollback becomes available on the **first real upgrade**.
Never delete the previous release until recovery is independently verified.

## swy1

Retain `devspace-owner-backup.timer` and `devspace-owner-health.timer`, the
stable ingress, immutable pinned Core, and existing specialized release
scripts. Update only the timer service ExecStart to its pinned backup script
and the common owner guard; do not switch swy1's public OAuth authority as
part of PC onboarding. The PC standalone switcher is not safe for swy1's
live coordinator because it does not pause and drain the stable ingress.

## Recovery limits

Online snapshots and verified release switches protect recoverable state, not
machine hardware, the physical disk, DNS, external OAuth providers, or
in-flight clients during a PC standalone restart. Validate rollback on a
new tested candidate before claiming the entire path has been exercised.
No schedule automatically upgrades releases or performs an unattended
rollback on a transient network probe.
