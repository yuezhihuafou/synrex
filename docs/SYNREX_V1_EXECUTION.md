# Synrex V1.0 — outcome-first execution and acceptance ledger

Last verified: 2026-10-21. This is a working evidence ledger, not a claim that V1.0
has passed final acceptance. Source, test receipts and active release manifests
take precedence over this document.

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
- **P3 evidence:** The capability fixture proved relevant retrieval and
  explicit promotion, but production has no validated reusable candidate.
  Do not promote generic `pnpm typecheck` suggestions merely to inflate the
  memory counter. Evaluate genuine revision-scoped history against no-recall.
- **P4 production:** Source edits are not live until a clean, reproducible
  immutable candidate passes packaging, relevant/full regressions, isolated
  authenticated MCP/OAuth and Console QA, owner-state backup, rollback-ready
  activation and both-node postflight.

## Next independent actions

1. Finish typecheck, full regression, architecture and package build for
   these real source changes. Review the diff and preserve rollback.
2. Validate current task IDs and new handoff in a real authenticated QA MCP
   server; measure new-vs-old response bytes and processing time.
3. Promote only an immutable validated candidate; record new source hash,
   manifests, asset fingerprints, backups and postflight.
4. Run comparable full-host T1–T5 pilot tasks with **the same** model,
   thinking effort and starting SHA for both configurations; report unmatched
   runs honestly.
5. Extend deterministic fault injection to lost writes, link partitions,
   cancellation, and actual fresh-chat takeover. Only then consider V1.0
   performance/recovery acceptance achieved.
