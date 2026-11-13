# Synrex development / production consolidation (2026-11-13)

## Starting evidence — not inferred from branch names

| Runtime/source | Verified starting identity | Meaning |
| --- | --- | --- |
| swy1 Owner Core | `b3a20cb5193df7a7d95957283ff04f71aeb40e7d` | Actual pinned `devspace.service` v0.2.0 production baseline |
| swy1 independent Console | `65a09df14a4d0a7f50e45ac003be001e4061ab8b` | Later pinned Console release, independently active |
| swy1 Tunnel guard | Uncommitted observer assets in the mutable development checkout | Already operating as a separate user timer; not part of Core source release |
| Mutable root checkout | `c9e1002972c5bda592d65cd18412998a097e4216` | Historical development branch, **not** production |
| Public canonical source | `origin/main` | Only verified merge/release authority; no implicit worktree promotion |

The inspected local Git repository had 23 worktrees, 17 with uncommitted
changes. Their dirty state, untracked files, and local experiments were **not
deleted, reset, stashed, or overwritten** during reconciliation. A dirty
worktree is not evidence that every edit is production-ready. Do not merge
all worktrees or replace the known-good Core with a historical branch.

## Selected changes brought forward for the next release

- Replayed the eight clean independent Console commits `49d410d`,
  `9335c1a`, `2e56d29`, `30090a9`, `044b72b`, `7954567`,
  `00f1662`, `65a09df` on top of the Core baseline, without introducing
  their older Core source snapshot.
- Carried forward the bounded Tunnel-availability guard into source control
  as an **optional** Linux observer, without making it part of MCP authority
  or automatically changing the deployed watchdog.
- Verified that the root branch's DBS-skill filtering change (`669a013`)
  was already functionally present in the published Core; the cherry-pick was
  empty and intentionally skipped rather than creating a meaningless commit.
- Bundled Console browser/server assets with the same source-backed release
  as Core, while maintaining independent authentication, state and process
  lifecycle.
- Added isolated per-version portable installation, explicit activation,
  rollback, and additive OS service definitions; legacy `devspace` client
  names and production OAuth identity remain unchanged.

## Preserved but not silently promoted

Other worktrees contain unfinished learning/workflow experiments, Console
revisions, benchmarks, document QA utilities and project-specific material.
Their uncommitted state and baseline differences need individual tests and
owner review. Neither a newer file timestamp nor more lines of code justifies
overriding the production contracts. Their existence is retained; inclusion
in a public build requires a selected, verified change with a specific product
benefit. Research Harness and robotics projects are outside Synrex Core.

At this audit, `gateway` was offline. Windows was reachable and its Node
v24.13.0 installer, version-pointer, rollback and generated Task Scheduler
script were tested with an isolated local fixture. A real GitHub tarball
download on Windows timed out; it is **not** evidence that the full Windows
package has been installed successfully. macOS is covered by service
definition tests but had no native host acceptance in this session.

## Release conditions

1. The selected code must build cleanly from a Git-clean commit that descends
   from the current immutable Owner Core.
2. Core tests, new Console tests, npm package-content smoke and optional
   guard/portable installer tests must pass; integration failures may not be
   hidden by editing away legitimate assertions.
3. At least the Linux pinned candidate must pass isolated authenticated MCP,
   OAuth and Console checks. A Windows/macOS feature may only be advertised
   at its actually tested support level.
4. A GitHub `main` CI success, unique immutable semantic-version tag,
   downloadable release archive, and verified source/build fingerprints are
   required before production promotion.
5. Core and independent Console require **separate** activation checks, each
   with a compatible previous version and rollback. Gateway/Windows peer
   upgrades are separate, optional host actions.

Do not move the existing `v0.2.0` tag. The next release, if fully verified,
is `v0.3.0`; merely changing `package.json` is not proof of publication.
