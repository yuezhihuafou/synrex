# Decision: one swy1 owner-release transaction across the full promotion

Date: 2026-10-27. Scope: Synrex production release operations, not routine
editing or Research Harness. The existing stable MCP/OAuth ingress and primary
Core release identity remain unchanged until the guarded activation.

## Incident and boundary

Two ChatGPT conversations can edit different Git worktrees concurrently, but
the earlier `promote-main.sh` performed build and QA in the calling MCP command
and locked only the final activation. Competing conversations could therefore
build candidates and dispatch overlapping promotions. A Core replacement could
also interrupt the tool invocation responsible for its own deployment.

## Decision

- Continue parallel development in separate Git worktrees. Do not serialize
  arbitrary Shell commands globally or silently merge unrelated dirty work.
- Make `promote-main.sh --deploy` **dispatch** a dedicated user systemd unit.
  That unit runs provenance checks, candidate build/tests, authenticated smoke,
  immutable packaging, owner-state backup, activation and rollback. It has a
  stable, inspectable systemd unit identity and survives a Core restart.
- Reuse the existing swy1 `owner-release.lock` for the **entire** worker
  transaction and for `--check` candidate builds. Other promotion/check,
  activation, rollback and ingress migration attempts fail closed while the
  release lock is held. The activation child verifies and reuses the inherited
  lock file descriptor; it must never unlock/relock between build and switch.
- A successful dispatch is **not** successful deployment. Confirm the worker's
  terminal outcome and `release-receipt.json` plus active Core manifest,
  authenticated public ingress, Console freshness and agent worktree access.
  Failure/unknown status is not permission to replay uncertain mutations.
- Candidate == current canonical remote `main` at preflight and cutover;
  candidate includes current pinned production. Immutable SHA/provenance,
  state backup, stable ingress pause/drain, health checks and rollback remain
  mandatory. Workspaces with uncommitted changes cannot be release sources.

## Alternatives rejected

- Only lock `activate-owner-release.sh`: leaves concurrent candidate builds
  and pending promotions outside a single controlled transaction.
- Run the release in the ChatGPT MCP command: restarting its Core can sever the
  call before the deployment receipt becomes observable.
- Force all conversations onto one shared checkout or automatically merge
  unfinished worktrees: unsafe and unnecessary for independent development.

## Validation and limitations

`tests/test_promote_main_transaction.py` checks independent dispatch and
fail-closed build contention. `tests/test_activate_owner_release.py` checks
inherited descriptor continuity, rejected forgery, normal mutual exclusion and
rollback. `src/managed-worktree-authorization.test.ts` covers allowed/pruned/
forged worktree identities. Production success additionally requires the real
immutable candidate, CI-like QA, authenticated smoke and an actual pinned
release receipt. These tests cannot prevent an unrelated person with direct
shell authority from bypassing the approved release scripts; they also do not
claim to repair a ChatGPT-owned reply stream disconnect.
