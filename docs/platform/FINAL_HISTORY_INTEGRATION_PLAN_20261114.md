# Synrex 历史开发最终整合计划与验收台账

Status: execution plan, 2026-11-14. This plan is not a release receipt.
Canonical authority is `origin/main`; production authority is the pinned
`devspace.service` manifest. Never infer deployed behavior from a branch.

## Product boundary and definition of "final"

The goal is **closure of the historical development backlog**, not adding every
experimental file to the product. Every known branch/worktree must have one
recorded outcome: integrated, equivalent implementation already shipped,
intentionally rejected/replaced, standalone external tool, or externally blocked.
"Final" does not mean auto-resuming a stopped ChatGPT reasoning turn, forcing
identical builds on peers, or bundling Research Harness/robotics work.

The last verified release baseline is `v0.3.0`,
`7c4b39b757e939fbc8ba4524f931f61147a9ef07`. The original dirty
`/home/swy/DevSpace` and all existing worktrees stay untouched. Run the
integration in a newly created, isolated worktree based on canonical main.

## P0 — historical feature evidence and selected integration

| Historical line | Integration decision | Verification gate |
| --- | --- | --- |
| `synrex/p1-p4-lifecycle-20261028` (`a8ce236`) | Adapt the useful workspace lease, reconnect and lifecycle inventory, but never automatically delete unknown or dirty worktrees | Parallel clients, stale/active leases, upgrade of old SQLite, checkout protection, controlled dry-run and explicit approval |
| Console operational WIP in `DevSpace-9dd8e068` | Adopt runtime/collector release mismatch detection and read-only operational metadata; preserve existing independently deployed monitors | Correct stale/old release signal, no auth bypass, no PII leak, collector failure isolation |
| Console request helper in `DevSpace-f4bf1e76` | Compare with main's existing AbortController and timeouts; import only materially missing behavior | Disconnected and overlapping snapshot tests, same auth semantics |
| Antigravity multiline test/evidence WIP | Preserve provider portability; integrate tests only if they catch a real regression, never assume service login | Mocked CLI outputs and safe optional provider behavior |
| LearningStore/Completion Mailbox historical branches | Reuse newer main implementations; do not reinstate weaker evidence gates or duplicate state | Existing tests and verified terminal receipts |
| Media observation, terminal output, P012 Console, brand/site branches | Historical patch equivalents already present; retain provenance but do not create duplicate implementation | `git cherry` patch comparisons and current functionality |
| 2026-09 backup and v0.1 platform snapshots | Legacy historical bases; not merge candidates for the newer owner | Source/CI provenance; no old config or OAuth overwrites |
| Benchmarks, `scripts/docqa`, ROS2/robot code, Research Harness | Keep as separate tools/projects when relevant; exclude from Synrex runtime dependencies | No accidental runtime imports or packaging |

**Non-negotiable:** all historic dirty files remain inspectable until
explicitly discarded by their owner in a separate maintenance task. No
`git reset --hard`, blind `git clean`, forced worktree prune, automatic
garbage collection, or mass merge.

## P1 — operational and security closure

1. Core and standalone Console must report **actual** pinned release identity,
   not a configured/stale snapshot. A mismatched collector release is stale
   even if its timestamp looks fresh; an unavailable peer must show unknown.
2. Keep browser management separate from MCP/OAuth, and preserve existing
   login, CSRF/Origin, HttpOnly cookies and bounded APIs. A private LAN port
   bound on all interfaces must be documented as an exposure, never asserted
   safe merely because the API requires a password.
3. Worktree lifecycle must be conservative: **preview/read-only default**;
   never delete directories outside a verified managed Git worktree; reject
   dirty, active, leased, unknown-owned or wrong-repository worktrees. No
   background removal in the final-consolidation release unless separately
   justified and tested.
4. Expose disk pressure/low-space observations without creating a second
   storage authority or auto-deleting user data. Preserve diagnostic provenance
   and bounded runtime cost.

## P2 — portability and real workflow validation

| Environment | Minimum acceptance | Unsupported outcome policy |
| --- | --- | --- |
| Linux/swy1 | Clean build, tests, packaged npm CLI + Console HTTP login/health, pinned source manifest, rollback test, public ingress continuity | No production promotion if any blocker |
| Windows peer | Genuine tagged archive or verified transferred archive, isolated side-by-side install, CLI + task lifecycle; existing peer identity not replaced | Report as compatibility-only until actual archive and live peer pass |
| gateway peer | Actual online negotiated contracts, task ownership after disconnect/rejoin | Keep optional and list offline blocker, never route robot commands elsewhere |
| macOS | Native installation/service/CLI checks | Report as not validated when no native runner exists |
| ChatGPT ordinary conversation | Real inspect/edit/test/review, new-chat workflow resume and interruption behavior with receipts | Do not claim GPT auto-continuation from local task completion |

Run performance/reliability probes on unchanged inputs. A passed synthetic
test is not a statistically supported superiority claim.

## Hard release gates (vNext, not a predetermined success)

1. Feature ledger updated for **all** divergent branches and dirty worktrees,
   with provenance and inclusion/exclusion rationale.
2. No unintended changes to OAuth/SQLite issuer/identity, robot projects,
   owner paths, old service units, or uncommitted worktrees.
3. Typecheck, architecture tests, targeted lifecycle/Console/unit tests, full
   supported regression, package installation, authenticated isolated MCP and
   Console smoke tests. No deliberate failing test assertions or skip inflation.
4. Reproducible source/build fingerprints match a **clean** commit descending
   from `v0.3.0`; GitHub `main` CI must pass. A new annotated tag is never
   moved or reused; release asset and checksum must exist.
5. For production: backed-up state, verified immutable candidate, atomic
   activation with rollback, real service and OAuth ingress probes. Core and
   independent Console are verified separately.
6. Any unavailable Windows/gateway/macOS qualification is a recorded limit;
   it cannot be silently turned into a green release claim.

## Closeout artifacts

- This plan and a final branch/worktree decision ledger.
- Verified new source commit, test/CI receipts and release manifest when
  published; separate Core and Console active-release evidence.
- Blocker list with next reproducible action for every unsupported platform.
- Current clean-main developer workflow, without rewriting older dirty source.
