# Synrex cross-conversation source review — 2026-10-27

This file pairs the previously requested outcomes with actual source files,
original worktree heads and the current canonical main. It is **not** an
authorization to delete a dirty worktree or claim every unfinished
experiment has shipped. The read-only Git inventory and worktree retention
ledger remain in `WORKTREE_REGRESSION_RECONCILIATION_20261027.md`.

## Source of truth and method

- Starting canonical GitHub `main` and pinned swy1 Core:
  `57107116dc76ea8d12c72c89f8f24e674cec980c`. The release is
  verified independently of Git history via the systemd pinned path.
- The corresponding earlier conversations were revisited for goals and
  reported acceptance: P012 Console monitoring, Usage/Productivity,
  task outcome/reconnect, LearningStore, Antigravity, multi-host/port
  ownership, and optional Windows nodes.
- For available original worktrees, read actual source and `git diff` rather
  than infer completion from commit timestamps. Old commits are not
  automatically new features: cherry-picks and redesigned implementations
  have different SHAs. Shared Git objects are preserved via the archive
  refs recorded in the earlier worktree ledger.
- A prior gateway isolated worktree was no longer addressable by the current
  Synrex workspace registry. Do not circumvent `allowedRoots` to retrieve
  uncommitted content; treat its exact delta as unverified.

## Reconciled outcomes

| Original goal / source | Current source evidence | Decision |
|---|---|---|
| P012 real process and event timeline; workflow evidence / `0125b1a`, `492e8c6` | `src/console-snapshot.ts` reports active task units, process status, timeline and classified outcomes. `src/ui/console-app.tsx` displays those values. | **Already integrated**; complete the per-source activity/freshness distinction below instead of replacing the whole Console. |
| Usage & Productivity Console / `e9114fb` | `src/console-usage.ts`, `src/usage-ledger.ts` and current Console implement usage trends, Git activity and export. | **Already integrated**; model-side private tokens and manual reminder counts remain unobservable. |
| P0–P3 outcome-first/long-task recovery | `src/execution-outcome-loop.ts`, `src/task-final-barrier.ts`, `src/coding-workflows.ts`, task receipts and stable ingress retain explicit completion rules, no unsafe replay and running-job continuity. | **Already integrated**; these rules cannot autonomously wake ChatGPT after a turn ends. |
| LearningStore retrospectives / old swy1 `DevSpace-9a802929` and `DevSpace-4fe5d08e` | Current `src/learning-store.test.ts` has the identical content hash as the original uncommitted test (`ff5eb6fc`); `learn_review/record/distill/promote` and workflow notes exist in main. | **Already integrated** for one workspace; add explicit read-only cross-worktree recall below. |
| Multi-conversation worktrees and project context | Separate worktree roots kept LearningStore records isolated, even when two conversations worked in one registered Git source repository. | **New targeted fix:** `includeProjectWorktrees: true` returns bounded related retrospectives without importing raw evidence or granting cross-worktree write/promotion rights; default remains isolated. |
| Gateway P012 fixes / `4351ab2` and 14 uncommitted tracked files | Current main includes separate directory-level admission, race-aware patch preflight and optional project-node bindings with tests. | **Already integrated/rebased**; keep gateway's private dirty work, not its older whole checkout. |
| Subagent AGY multiline JSON / swy1 `DevSpace-e90486bb`; provider evidence / `DevSpace-a09a35fb` | Current generic CLI parser accepts pretty JSON, captures real terminal outcomes and session IDs; `local-agent-antigravity-sandbox.ts` controls auto-approved runs with Linux namespace isolation. | **Already integrated with safer implementation**; never copy direct unsandboxed permission bypass from old branches. |
| Legacy OAuth/architecture overhaul / swy1 `DevSpace-0d39e6ed` | Old tree has 53 modified tracked files on a much older base, including OAuth and DB schema. Current production has different active issuer, SQLite and rollback contracts. | **Preserve for specific reviewed follow-up only**; direct merge risks breaking the single authority. |
| Gateway task final barrier/execution outcome WIP / `DevSpace-ffe8c1cf` | Both named modules and associated verified tests already exist in main, but the original gateway uncommitted delta cannot be confirmed through current workspace access. | **Existing behavior tested; source delta not falsely marked reviewed.** |
| Optional Windows/WSL laptop enrollment | Gateway's untracked scripts contain host-specific SSH details and transfer a join credential; no signed portable enrollment release or live Windows validation. | **Not published:** optional feature requires independent security review. Gateway is never mandatory. |
| Research Harness/robot experiments | Independent task-specific application and hardware protocols, not generic coding platform modules. | **Exclude from Synrex Core**, preserve original files. |

## Historic non-terminal workflow checkpoints

The owner SQLite workflow registry still listed **seven** saved
`active` or `blocked` entries during this audit, including two earlier
P0–P3 deployment workflows blocked on long-lived MCP connections and a
Console observability workflow awaiting per-source freshness. The live
production deployment and continuity checks occurred after some of these
checkpoints. **Neither a stored `active` status nor a newer deployment SHA
alone proves that the original acceptance criteria have been satisfied.**
Do not mass-mark them completed or replay historic deployment steps.

The Console previously displayed source heartbeat timestamps, but did not
collect last activity for all sections in one explicit read-only view. This
candidate adds a small `dataFreshness` summary with independent most
recent node heartbeat, workflow checkpoint, verified local task activity,
diagnostic event and runtime sample times. Its `sampledAt` is labeled as
snapshot collection time, not a heartbeat or proof of recent activity.
Historical workflow states are labeled as saved checkpoints rather than
running OS processes. No extra collector, scheduler or database is introduced.

## Targeted integration and safety rules

1. Only verified, source-root-matched registered worktrees can participate in
   explicit project retrospective recall. Cross-project notes, secrets,
   raw episodes and evidence authority remain isolated. Historical notes
   survive a Git worktree prune as long as their registered source identity
   and learning rows remain stored.
2. Validate both direct LearningStore behavior and real in-process MCP
   `project learn_recall`, including opt-out and no cross-worktree promotion.
3. Preserve the public single-owner OAuth/SQLite runtime, immutable
   production pin and previous release. Do not redeploy or restart the live
   Core until the selected diff passes its independent release gates.
4. Worktree retention is distinct from code integration: do not use a clean
   SHA or a short Git ancestry gap as proof that another conversation's
   unfinished steps are complete. Keep untracked/dirty original files.
