# Synrex retained WIP: source and conversation decision record (2026-10-27)

Status: decisions against canonical `origin/main` at `0c0389f5fa1b`.
This record is **not** an authorization to reset or delete another conversation's
worktree. Production Core/OAuth, remote node roles, hidden provider configuration
and historical experiment data remain outside this code review's write scope.

## Evidence and earlier acceptance constraints

The review joins the two host inventories
(`~/.local/state/synrex/convergence-20261027/{swy1,gateway}-worktrees-current.tsv`),
file-level inspection, `git cherry` patch equivalence, existing tests,
`docs/platform/CONVERSATION_WIP_INTEGRATION_REVIEW_20261027.md` and relevant
prior-conversation summaries. Chat summaries establish **intent**, not an
independent complete transcript or proof of shipped behavior.

- **2026-10-22 P012:** lightweight Clash-style Console observability for
  active processes, diagnostics and statistics; avoid destabilizing service.
- **2026-10-26 P0-P3:** reliable terminal outcomes, recovery after disconnects,
  multi-chat worktree isolation, Subagent/Gemini, compact handoff and telemetry.
  Never force-restart Core while other conversations have active tool connections.
- **2026-10-27:** both Console snapshot and immutable Core must identify the
  same release; protect the single-owner release lock; retain dirty worktrees;
  GPT owns architecture and acceptance while delegating bounded coding work.
- **2026-10-27 disk incident:** keep storage/SQLite/backups protected; avoid
  adding high-rate independent collectors just to add UI statistics.
- **Research Harness/ROS2:** remains a separate research/robotics project.
  Do not introduce domain-specific experiment or robot hardware behavior into
  the general-purpose Synrex Core.

Source audit from the previous turn:
`synrex_unmerged_worktree_audit_2026-10-27.md` (user conversation artifact).
Production and Git refs were rechecked; at decision time both pointed to
`0c0389f5fa1b`. Historical WIP may change in its owning conversation.

## Directly integrated, selectively (not old whole modules)

1. **Gateway `DevSpace-5902de48` / Console Timeline concept:** Existing
   `src/diagnostic-trace.ts` already distinguishes completed HTTP, early
   close and tool execution without observed HTTP. Add one previously missing
   **combined** state, `tool_completed_connection_closed`, for the case in
   which the tool finished but its MCP connection ended early. It does **not**
   claim ChatGPT received the result, nor that the user goal succeeded. Add
   isolated diagnostic and Console label tests. Keep the existing event
   recorder, owner Console and stable ingress unchanged.
2. **swy1 `DevSpace-9dd8e068` / Release consistency checks:** The current
   production-safe `active-console-snapshot.mjs` already resolves the
   active immutable Core from systemd, with manifest/build matching. Import
   its **missing test scenarios**: active/failed Core, missing pinned command,
   symlink, divergent revision or fingerprint, and wrong release root.
   Run the regression in the normal test suite. Do **not** copy the older
   activation, publishing, service installer or Console UI, which can bypass
   the newer transaction lock and remove the current delegation widgets.

Both changes are additive to already implemented behavior. The old reports
and scripts themselves remain in their original worktrees for provenance.

## swy1: 16 WIP worktrees

| Worktree | Decision | Source reason |
|---|---|---|
| `0d39e6ed` | HOLD | 53 old-base tracked edits plus untracked OAuth/config/schema and build artifacts. Different single-owner state and public identity contracts; no wholesale merge. |
| `19817826` | SEPARATE | Upstream pnpm workspace/lock reproducibility files; not product logic. |
| `3844de94` | REJECT Core import | `test/synrex-smoke-acceptance/engine.py` contains only a two-number addition and one trivial test. It does not exercise MCP/OAuth/Console smoke acceptance. |
| `4d9f36a1` | SEPARATE | `eval/` benchmark corpus and ledger; keep measurements and frozen protocol, do not add bulk experiment data to Core. |
| `4fe5d08e` | COVERED/HOLD | 11 LearningStore/Console files and learning note; same 7 of 12 worktree candidate files as `9a802929`. Main includes scoped `learn_recall` and independent read-only cross-worktree opt-in. |
| `6cc20cba` | COVERED | Release activation/snapshot alternatives are older than current inherited owner release lock and active collector. |
| `9a802929` | COVERED/HOLD | Same LearningStore effort with five differing local variants; do not replace current project isolation/verified evidence. |
| `9dd8e068` | PARTIAL INTEGRATION | Release mismatch test scenarios selected. Additional network/Git operations collector uses Python inspection, caching and historical worker/CLI assumptions; no new periodic or production endpoint without measured cost, security and stable-issuer acceptance. |
| `a09a35fb` | KEEP BENCHMARK | Antigravity/provider code covered by sandboxed generic CLI; architecture ABC comparison scripts are a read-only pilot, not reproducible product acceptance or authority to choose a provider by quota. |
| `a5e16c32` | CRITICAL HOLD | Local `main` worktree with 177 **staged** modifications (93 deletions, 84 changes). Protected index and branch; never reset or auto-commit; no mass deletion cherry-pick. |
| `a97e0a18` | SEPARATE | Six independent DocQA scripts/tests for Word redlines and factual preservation, with optional native Office/tool dependencies. Validate as a standalone document QA utility, not Synrex Core. |
| `b5952774` | COVERED | Old `server.ts` plus coding workflow modules; main has bounded workflows, acceptance and final result handling. |
| `e90486bb` | EXACT TEST OVERLAP | Older Antigravity multiline fixture expects `PRETTY_OK`; current `src/local-agent-antigravity.test.ts` already tests pretty JSON, token usage and lack of fabricated tool events. |
| `e9eaf0b5` | DUP / preserve | Four three-way benchmark fixtures, byte-identical to two older benchmark worktrees. |
| `7d956279-6d530463` | DUP / preserve | Same four fixture SHA-256 digests; no deletion while session/experiment ownership persists. |
| `19817826-7e5912be` | DUP / preserve | Same four fixture SHA-256 digests; upstream comparison variant. |

## swy1: 12 clean worktrees with unique Git ancestry

| Worktree | Decision | Evidence |
|---|---|---|
| `0571accb` | EQUIVALENT | `git cherry` marks reliability/P012 patch equivalent. |
| `1f2124ce` | COVERED | Earlier outcome recovery `0125b1a`; current durable final barrier, diagnostic and recovery code supersede this old patch. |
| `4a45e557` | EQUIVALENT | Terminal output receipt patch already equivalent. |
| `56fdfdf6` | COVERED | Another earlier P012/outcome recovery variant; no proof a whole old branch is required. |
| `58538019` | EQUIVALENT | Two parallel worktree test patches equivalent. |
| `94b56b49` | EQUIVALENT | Bounded cross-node visual evidence patch equivalent. |
| `9e1299d4` | COVERED | Persistent Console usage already implemented in `console-usage.ts`, usage ledger, snapshot and UI. |
| `b3fd255d` | COVERED/SEPARATE | ROS2/media/physical-root branch; generic observation and edit coordination are present, robot-specific experimental logic stays external. |
| `ebcbfffb` | HOLD | Brand and legacy service identity rename could break existing owner OAuth and ingress; no unverified rename. |
| `f4cdd2e2` | COVERED | Another P012 outcome/peer-draining variant; do not replace newer recovery. |
| `7d956279-df2e4432` | EQUIVALENT | Old Dev T1-T3 controlled benchmark test equivalent. |
| `candidate-src` | ARCHIVE | Frozen v0.1 provenance, not the current pinned release or upstream source. |

## gateway: 9 WIP / unique-commit worktrees

| Worktree | Decision | Evidence |
|---|---|---|
| `DevSpace` | HOLD | Dirty root includes generic tooling, private peer configuration and Research Harness; `bffd415` is an old branding commit, not a coherent current-main integration. |
| `5902de48` | PARTIAL INTEGRATION | New timeline classification selected. Its `qa-profile.ts` chooses a separate QA port/store but would create another configuration convention without covering the existing authenticated isolated release QA. Preserve source, do not bind another public issuer or restart Core. |
| `5917b5c0` | COVERED/HOLD | Old Antigravity sandbox chain; current sandbox and generic CLI driver exist. |
| `5fbe95ac` | COVERED/SEPARATE | Old media/ROS2 cross-node experiments, not generic platform changes to cherry-pick. |
| `bb78b18a` | COVERED/HOLD | Generic CLI Antigravity and media observation shipped in newer form. |
| `ffe8c1cf` | COVERED/SEPARATE | Current Core contains `execution-outcome-loop.ts`, `coding-workflows.ts` and `task-final-barrier.ts` plus tests. LayerFS measurement data stays experiment evidence. |
| `8f6cb721` | COVERED | Current `local-agent-context-pack.ts` already implements bounded Git grep, hints and Serena outlines; do not replay 10 old history commits. |
| `e3d6a2c7` | COVERED/SEPARATE | ROS2/video capture and early physical-root coordination now superseded by generic capabilities. |
| `e4ada141` | COVERED/HOLD | Durable task redelivery and bounded diagnostics implemented in current `durable-tasks.ts`; old browser trace and namespace changes have privacy/security and release dependencies. |

## Exclusions, tests and release gate

- Nothing from a dirty worktree was staged or mutated. No cleanup, hidden
  provider permission bypass, OAuth key/issuer rewrite, peer-authority switch,
  Research Harness migration or robot command is part of this integration.
- The earlier gateway Codex review failed `workspace routing discovery failed`;
  direct host code inspection and current executable tests remain the evidence.
- This source change adds no Console collector, periodic Git scan, background
  model loop or independent public service. Compare active release and tests
  separately from `origin/main`: a source-only commit does not deploy.
- Any later standalone DocQA, Benchmark, QA profile or provider implementation
  should be specified/tested in its own scope rather than smuggling it into
  the production integration.
