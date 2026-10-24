# swy1: native Antigravity execution on Ubuntu 24.04

Status: isolated Synrex implementation and host prerequisite, 2026-10-24.

## Root cause

On `swy1` (Ubuntu 24.04, kernel `7.0.0-38-generic`),
`kernel.apparmor_restrict_unprivileged_userns=1` and `/usr/bin/bwrap`
had no attached AppArmor user-namespace profile. The kernel allowed an
empty user namespace (`unshare -U`), but denied the UID map required by
`unshare -Ur` and `bwrap` with `Operation not permitted`. On gateway
(Ubuntu 22.04), the corresponding sysctl was `0` and bwrap worked.

## Minimal host remediation (completed)

1. Obtained Ubuntu's signed-index `apparmor-profiles` package
   (`4.0.1really4.0.1-0ubuntu0.24.04.9`) and extracted the official
   `bwrap-userns-restrict` profile. Syntax validated with the installed
   `/usr/sbin/apparmor_parser -Q`.
2. Installed `/etc/apparmor.d/bwrap-userns-restrict` and loaded precisely
   this profile with `/usr/sbin/apparmor_parser -r`. A **one-time** privileged
   container was used solely as a root provisioning mechanism because the
   user account has no passwordless sudo. The production Synrex service
   was not restarted during this host setting change.
3. Verified ordinary-user `bwrap --ro-bind / / --proc /proc --dev-bind /dev /dev -- /bin/true`
   returns zero. The global restriction remains **1**, so ordinary
   `unshare -Ur` remains blocked by design.

This does **not** turn Synrex into a Docker workflow. Normal Subagent
processes launch the host's native `bwrap`, read and edit the real selected
host workspace, and run host Node/Python toolchains. Container runtime
and image creation are not required per task.

## Agent permission model

The source uses `--dangerously-skip-permissions` only inside its mandatory
native mount namespace. The host root is read-only. The requested project
is explicitly writable for `allowed` tasks and read-only for `read_only`
tasks. Existing Git metadata and SQLite files are read-only; private
Antigravity session files are copied into ephemeral writable state.
Host secrets and privileged sockets are not exposed as write targets.

This is **file-write isolation**, not network/data-exfiltration isolation.
For unknown, high-impact changes use a disposable Git worktree; code
inside an explicitly writable workspace can still remove its own files.

## Operations

- Check prerequisite: `bwrap --ro-bind / / --proc /proc --dev-bind /dev /dev -- /bin/true`.
- View policy: `/etc/apparmor.d/bwrap-userns-restrict`.
- Rollback (root only): unload that one profile with
  `apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict`, then remove
  `/etc/apparmor.d/bwrap-userns-restrict`. No global sysctl modification
  is necessary either to install or roll back.
- Ubuntu `apparmor` upgrades may ship or alter the same filename; inspect
  conflicts and profile attachment before reapplying this setup.

Native Gemini and isolated production-release verification results belong
in the final release receipt; a successful bwrap preflight alone is **not**
evidence that the model completed an engineering task.
