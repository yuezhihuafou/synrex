# Synrex historical feature closure ledger — 2026-11-14

This ledger is paired with the **read-only** command
`node scripts/history-audit.mjs --json`. Its results are local evidence;
do not commit its raw output because it includes private paths. At the initial
candidate inspection the repository had **24 local branches, 25 worktrees,
18 dirty worktrees** (17 historical dirty trees plus this integration tree).
The observer does not modify any of them.

## Git history decisions

The public `v0.3.0` baseline is
`7c4b39b757e939fbc8ba4524f931f61147a9ef07`. At inspection 11 local
branches were not ancestors of `origin/main`; this alone is not evidence of
missing functionality. Review decisions:

| Branch/era | Decision | Reason / evidence |
| --- | --- | --- |
| `console-monitor-p012` | equivalent | Original independent monitoring changes replayed during v0.3 consolidation |
| `synrex/console-s123-20261022` | equivalent | Monitoring, SSH metrics and SQLite migrations present in v0.3 |
| `feat/observation-media-20261026` | equivalent | Image/media observation changes already matched by `git cherry` |
| `feat/synrex-terminal-output-20261026` | equivalent | Bounded output/final receipt patch already matched |
| `release/public-20261023` | equivalent | Multilingual public site changes already matched |
| `synrex/experimental-mailbox-v0` | superseded | Core already uses Completion Mailbox/final barrier; old branch is not a safe release source |
| `synrex/dev-main-20261027` | semantics covered, work preserved | DBS-skill isolation already present in v0.3; old branch has additional local commits, avoid blindly replaying |
| `synrex/p1-p4-lifecycle-20261028` | **selected for this integration** | Workspace reuse, leases, conservative lifecycle list/preview migrated with updated safety policy |
| `backup/pre-upstream-sync-20260908` | preserved legacy | Historical DevSpace Compact snapshot; newer Core must not be replaced with it |
| `platform/v0.1-candidate` | preserved legacy | Superseded old platform baseline; schema/package backport unsafe |
| `chore/synrex-brand-cleanup-20261025` | superseded | User-facing Synrex links already standardized; legacy service/issuer names intentionally preserved for compatibility |

Other local branches are ancestors of main or contain no independently
unmatched patch; the audit command lists each by actual SHA.
Upstream `Waishnav/devspace` branches are external dependency history,
not a Synrex feature backlog to merge wholesale.

## Worktree-level decisions

| Work category | Action / boundary |
| --- | --- |
| Original `/home/swy/DevSpace` checkout | **Keep untouched**: old development HEAD plus tracked/untracked Tunnel and other project data. Do not reset or use for release packaging |
| `DevSpace-0d39e6ed` historical large Core work | Preserve; most source edits have equivalent newer implementations; do not regress OAuth/learning safety by copying old files |
| `DevSpace-4fe5d08e`, `DevSpace-9a802929` learning experiments | Main has richer learning notes and evidence checks; retain older prototypes as reference only |
| `DevSpace-9dd8e068` Console operating experiments | Selected **release mismatch/stale snapshot protection**; other network/topology collectors remain standalone, unverified experiments rather than automatic privileged Core operations |
| `DevSpace-f4bf1e76` Console request polling | Main already has aborted overlapping HTTP requests; retain utility tests outside new Core until a reproducible regression appears |
| `DevSpace-a09a35fb`, `DevSpace-e90486bb` Antigravity variants | Core provider exists. Add a mocked pretty-printed/multiline CLI regression; retain optional experimental evidence collection outside release authority |
| `DevSpace-b5952774` workflow-only WIP | General workflow contract lives in main. No wholesale server replacement; cross-chat lifecycle branch is selected separately |
| `DevSpace-a97e0a18` Word QA scripts | External document workflow, not required for self-hosted Synrex coding |
| Benchmark and large fixture worktrees | Preserve raw evidence without shipping generated test data, build outputs, private environments or hardcoded hosts |
| Remaining historical, staging, QA and disconnected worktrees | Retain as explicit historical snapshots; their presence is **not** permission to force-prune or deploy |

The per-worktree statuses/SHAs are reproduced by the audit script; use the
local output and actual Git state whenever deciding whether a specific
untracked file can be discarded. **No historical WIP was deleted or silently
committed in this integration.**

## Deliberate safety changes

- The historical P1–P4 code attempted startup/periodic automatic cleanup.
  This integration makes startup **preview-only**, removes periodic GC and
  requires explicit `synrex worktrees prune --execute` on the intended peer.
  Unknown workflow ownership, dirty/untracked Git state, active leases,
  unfinished tasks and mismatched managed roots remain protected.
- The public Console is **read-only** for directory deletion, including an
  authenticated Owner session. Preview, selected process/disk inspection and
  lease information may be displayed; the destructive Console endpoint
  explicitly rejects `execute:true`.
- Snapshot freshness is evaluated against the **actual pinned Core release**
  when it is provable; a timestamp alone does not validate data from an older
  release. The independent Console release display is updated during a
  verified synchronous cutover instead of carrying a stale `--release` flag.
- Local disk pressure is observed without deleting, moving or compressing user
  data; unknown platform support remains explicitly unknown.

## Release gates and remaining external constraints

This integration is not a pass receipt. No full multi-host release claim is
allowed until clean-source CI, source/package/console tests, pinned deployment,
rollback and actual peer checks pass. **At initial audit Windows was online
but on v0.1.0, gateway offline on v0.1.0 and macOS untested.** These hosts
must not be reported as synchronized merely because swy1 ships a newer Core.
Real ChatGPT task continuation and model reasoning behavior are separate
acceptance tests, not implied by local unit tests.
