# Synrex V1.0 — outcome-first execution and acceptance ledger

Last verified: 2026-10-22. This is a working evidence ledger, not a claim that V1.0
has passed final acceptance. Source, test receipts and active release manifests
take precedence over this document.

## 2026-10-22 continued-work evidence (new conversation)

- Follow-up found that paired benchmarks with both model and environment
  controls missing were incorrectly accepted as comparable. Revision
  `7f4961d` requires matching, nonempty provider, model, effort, source
  commit and environment ID. Missing controls now give zero pairs and a null
  latency delta. Focused tests 8/8 passed, typecheck passed.

- The new ordinary ChatGPT conversation successfully called the connected
  Synrex MCP, reopened `/home/swy/DevSpace`, inspected
  `wf_d8ec6462633c505e20431c3c` revision 3, and found current live
  developer HEAD `12a4486` differs from the prior saved `211b2e3`.
  **Real fresh-conversation read-side takeover succeeded.** This does not
  show that ChatGPT autonomously resumes after a turn ends.
- Production is newer than the 2026-10-21 entries below: swy1 is actually
  running pinned `20261022-synrex-efficiency-v1-147af0e` (source
  `147af0e`); gateway is online on the older but tool-compatible build.
  The newer version already implements bounded multi-file read and
  deterministic staged verification. See
  `docs/SYNREX_EFFICIENCY_IMPLEMENTATION.md`.
- A disposable **deterministic remote lost-ack fault test** applies a
  simulated non-idempotent side effect before the remote transport throws:
  router does not retry; a subsequent workspace re-open recovers the same
  global workspace and task identities, with one side effect. This is
  fault-injection evidence, **not** a genuine WAN network-partition test.
  The new routing + benchmark focused set passed **14/14**, run
  `run_20261022050741_bdce08e9`.
- Host-visible benchmark context is optional: absent `contextBytes` now
  summarizes to `null`, rather than fabricating 0. This corrects evidence
  collection but cannot reveal ChatGPT's hidden context budget.
- No paired full GPT+original Dev versus GPT+current Synrex T1–T5 result has
  yet been collected. Do not infer the 20%/50% outcome targets from the
  routing fixture, request traces, or earlier 215-tool-call session.

## Verified starting state

- swy1 development checkout: `/home/swy/DevSpace`,
  `synrex/quality-closure-20261021` at `d9b576b`, clean **before** this
  engineering session. Preserve later changes.
- swy1 live owner: `devspace.service` runs immutable
  `20261021-synrex-reliability-v3`; release manifest identifies source
  `d9b576bc4272a6af3cdca7f503ded2a18e243d93`.
  Never use mutable `pnpm deploy:live`.
- swy1/gateway live node registry: both online, runtime contracts 17/17;
  Windows offline 13/17 (optional). Gateway **development checkout** was
  `4f219da` with 119 modified/untracked entries: it is **not** the running
  gateway release. Do not reset or deploy that dirty checkout. Its old
  `AGENTS.md` has obsolete mutable-deploy advice.
- Full 17-tool Synrex surface is available in this ordinary ChatGPT
  conversation. Legacy workflow `wf_42aaf9639cf12d66565b037d` has a
  stale checkpoint; the V1 workflow is `wf_d8ec6462633c505e20431c3c`.
- Owner LearningStore: 2,000 episodes, 1,959 marked successful, 0 candidates
  and 0 promoted at initial audit. These counters are not validated task wins.

## P0 observations and actual outcomes

| Experiment | Measured result | Evidence / interpretation |
| --- | --- | --- |
| Governance engine | 6/6 cases; 4 true blocks, 2 true allows; 0 false blocks | `pnpm -s benchmark:governance-engine`, run `run_20261021131734_011a0934`; component fixture only |
| Capability engine | 5/5 cases | `pnpm -s benchmark:capabilities`, task `task_41f27ca9998a4178`, run `run_20261021131729_f381303b`; 2 governance, 1 semantic, 2 learning |
| Semantic overhead | grep 2.36 ms; Serena find 2,496.58 ms and refs 5,121.18 ms | Same cold micro-fixture; not an end-to-end model task. Prefer simple scoped text search where sufficient |
| Real GPT coding: learning correctness | Red regression reproduced before source fix; after repair, 7/7 learning tests | `src/learning-store.ts` and `src/learning-store.test.ts`, run `run_20261021132308_698a8794` |
| Real GPT coding: metrics/comparability | 13/13 focused learning + metrics tests after changes | `src/benchmark-metrics.ts`, tests, run `run_20261021132635_e61e98c6` |
| Real GPT coding: takeover drift | Regression failed before change; passed after change (1/1 focused) | `workflow_status` now returns live Git evidence separately from saved checkpoint, run `run_20261021133448_8e856c17` |
| gateway durable shell | 14-second task completed with stable task ID | task `task_58962261187338d52cd66e47bd24ce36`, run `run_20261021132741_bce408c6`, exit 0 |
| gateway service restart during task | 28-second task completed, service PID changed 1152753 → 1183883 | task `task_b7667e38080a9b1549baf7b320520dd3`, run `run_20261021132857_174ee09e`, exit 0; log has exactly one start and one finish |

The current turn proves real GPT-directed inspect/edit/red-test/fix/retest work
through Synrex. **It does not provide a controlled GPT+old-Dev comparison.**
ChatGPT hidden context and full model time are not observable from the MCP
server. Do not substitute service-side request latency, shell runtime, or
Codex CLI results for these metrics.

## Lightweight reproducible task acceptance matrix

Use the existing `docs/agent-benchmark.md` JSONL schema and
`pnpm benchmark:compare <results.jsonl>`. Record a comparable source
commit, model, effort, host, time window and validation for every **pair**:

1. **T1 — Bug fix:** A failing test for an incorrect tool/command outcome.
   Pass: regression fails on original SHA, passes on final code.
2. **T2 — Cross-file feature:** Update a small existing API and its consumer.
   Pass: focused behavior + compile/test in a fresh fixture.
3. **T3 — Architecture refactor:** Move a module while keeping the approved
   dependency contract. Pass: functional checks and independent conformance.
4. **T4 — Durable execution:** Start a long build/test without blocking the
   host turn. Pass: terminal receipt with original taskId/runId, saved log
   and no unnecessary restarts.
5. **T5 — Recovery:** Interrupt the peer or MCP connection during a durable
   task, and separately after an uncertain non-idempotent operation. Pass:
   correct state reconciliation, no duplicate effect; ambiguous side effects
   must remain indeterminate until verified. New-chat handoff must detect
   changed Git state and inspect saved tasks.

Collect `success`, `wallTimeMs`, `toolCalls`, `contextBytes`,
`humanInterventions`, `retries`, `architectureViolations`,
`falsePositiveBlocks`, `recoverySuccess`, plus sample validity and reason.
If a metric is not observable, document it as missing and do **not** invent a
zero. Compare medians with paired samples; do not interpret one test fixture
or unpaired shell latency as a 20% GPT productivity gain.

## Current implementation and limits

- **P1 correctness:** Pending asynchronous commands no longer become
  successful LearningStore verification episodes. Structured nonzero
  exit codes and terminal failure statuses are failures, even without the
  MCP `isError` flag. Durable command **completion-to-learning correlation**
  remains a separate missing feature.
- **P0 metrics:** Median wall time/tool calls/interventions and observed
  recovery success are now reported. Duplicate pair keys are rejected;
  explicit mismatches in provider/model/effort/starting commit/environment
  are reported as incomparable, not silently paired.
- **P2 handoff:** `workflow_status(workflowId)` includes fresh local Git
  head/status, checkpoint drift and referenced task IDs, while marking
  checkpoint checks as self-reported. A true new-ChatGPT-conversation exercise
  is still needed after deployment.
- **P2 fault testing:** A real gateway service restart with an independent
  durable task has succeeded. This does **not** test all network partitions,
  write-ack loss, cross-peer task reassignment or cancellation races.
- **P3 evidence:** Initial deterministic retrieval/promotion fixtures passed,
  but actual production had historical false-positive `success=1`
  dispatch-only episodes. The **live** `020ec03` patch prevents those
  legacy receipts from supplying recall, checks, candidates or success
  counts while retaining the audit trail. Actual owner `learn_stats`
  reported 1,961 of 2,000 as successful before and 1,718 of 2,000
  after filtering. Three successful test episodes back one real
  version-scoped candidate, verified retrievable but not promoted.
  Measure revision-scoped retrieval against no-recall before broader use.
- **P4 production:** The first pinned source release
  `20261021-synrex-v1-progress-3974a10` passed the full 294/0/1
  regression and isolated 17-tool HTTP MCP/OAuth/Console QA, live
  `workflow_status` and backup-backed activation. The incremental
  **current swy1 production** release is
  `20261021-synrex-v1-progress-legacy-v2-020ec03` (source `020ec03`),
  which passed full 296/0/1 regression, package smoke, repeat isolated
  authenticated QA, owner-state backup and live postflight. gateway remains
  a compatible v3 execution peer. See
  [current release record](release-evidence/20261021-synrex-v1-progress-legacy-v2-020ec03.md)
  and [prior release record](release-evidence/20261021-synrex-v1-progress-3974a10.md).

## Next independent actions

1. Run comparable full-host T1–T5 pilot tasks with **the same** model,
   thinking effort and starting SHA for both configurations; report unmatched
   runs honestly.
2. Extend fault injection to lost writes, link partitions,
   cancellation, and actual fresh-chat takeover. Only then consider V1.0
   performance/recovery acceptance achieved.
3. Collect real hosted per-task latency/tool/context measurements with
   evidence; pair only genuinely comparable samples.
4. Test revision-scoped learning recall against no-recall and obsolete
   history, keeping promoted candidates evidence-linked and bounded.
5. Repeat selected full-host tasks on the pinned live release and capture
   any regression; perform a separate deliberate rollback drill when justified.
