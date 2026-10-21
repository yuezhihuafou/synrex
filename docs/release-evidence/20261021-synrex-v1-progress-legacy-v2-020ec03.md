# Synrex V1.0 progress: legacy-learning evidence repair, 2026-10-21

**Deployment verified; final V1.0 model-task superiority is not claimed.**
This incremental release follows and retains the earlier verified
[`3974a10` rollout](20261021-synrex-v1-progress-3974a10.md).

## Exact production and rollback identity

- **Current owner:** swy1 `devspace.service` pinned to
  `/home/swy/services/devspace/releases/20261021-synrex-v1-progress-legacy-v2-020ec03`;
  source revision `020ec03edeac3f68c2c6670912227de436978197`.
  Production switch unit `synrex-v1-progress-legacy-v2-020ec03-activate.service`
  completed `Result=success`, `ExecMainStatus=0`; live PID `2702538`.
- Source fingerprint `62eb978b752760e35538`; pinned manifest
  records 429 built `dist` files, SHA-256
  `d583838450bf8a331fc37336796125dcd233e8477c0da6aec261a2a5ffb8c837`
  and matching runtime asset digests. Authenticated 17-tool MCP schema
  fingerprint remains `b90cf80b9f85bd3568c5`.
- **Rollback baseline:** retain both pinned production releases,
  `20261021-synrex-v1-progress-3974a10` and
  `20261021-synrex-reliability-v3`, as well as the pre-switch systemd
  drop-in and the immutable candidate. A healthy live rollback *drill* was
  not performed.
- Fresh private owner-state backup:
  `/home/swy/services/devspace/backups/v1-progress-legacy-v2-020ec03-owner-precutover/owner-20261021T140827686141Z`.
  Both backed-up `devspace.sqlite` and `coding-workflows.sqlite`
  passed SQLite `pragma quick_check`.
- gateway remains on the compatible `reliability-v3` release with
  17/17 registered contracts. Its independent uncommitted checkout was
  neither touched nor reset.

## Why this source change was required

The preceding release stopped **new** `exec_command` responses with
`running=true` from being learned as successful verification.
Actual `learn_recall(query)` against production nevertheless surfaced
old `success=1` rows whose output began
`task=task_... working poll=5000ms`. A startup acknowledgment is
not evidence of a successful build or test.

This release conservatively filters those *historical* dispatch records
from recall, recent verified episode selection, suggested procedures,
candidate creation, promotion eligibility, CLI success counts and
Console success counts. Raw rows are retained for traceability; there is
no destructive migration of the existing SQLite history. A regression
reproduced the false success before the fix; after correction it passed.
The fix also covers `input_required` legacy dispatches.

## Real validation, not surrogate model results

- Focused LearningStore + Console: **10/10 tests passed**, including an
  injected old-format `success=1` pending receipt and promotion rejection.
  Run `run_20261021140306_f1109ed2`.
- Full project regression: **296 passed, 0 failed, 1 skipped**;
  `task_990d2208cb494052`, run `run_20261021140329_9ef1b666`.
  TypeScript typecheck passed; architecture conformance 0 errors,
  0 warnings.
- Isolated offline build from clean detached Git SHA `020ec03`:
  frozen-lockfile install, `pnpm build`, `pnpm release:source-check`,
  `pnpm architecture:check` all passed,
  `task_8e9816286551482a`.
- Packed installation smoke `task_ea47129d1d0d4628`, exit 0.
  Independent disposable authenticated HTTP MCP/OAuth/Console,
  17-tool schema, saved workflow/durable task restart, mailbox and
  Final Barrier passed: `task_c52c7f73b5da4217`, run
  `run_20261021140644_3dd64780`, exit 0.
- Post-switch local health 200, unauthorized MCP 401, Console 200,
  unauthorized Console API 401; public OAuth discovery 200.
  Actual ChatGPT `project` and `workflow_status` tool calls succeeded
  after restart; both swy1 and gateway stayed online with 17/17 contracts.
- **Observed production memory correction:** before the new filter
  `learn_stats` showed 2,000 episodes, **1,961 marked successful**;
  afterward 2,000 episodes, **1,718 eligible successes**.
  The memory is rolling, so this is an observed before/after count, not
  a controlled fixed-database treatment effect. The previously retrieved
  historic `ep_92fd61f1-7a36-4d8f-ab6a-e5a25c1c402b` pending
  launch no longer appears among results for
  `learning-store.test.ts pnpm exec tsx`.
- A real, version-scoped **candidate experience** was distilled from
  three successful test episodes:
  `skillcand_89f21d34-0875-4e2b-8081-834e37d4a12e`.
  It was retrieved by a relevant query, **not promoted** automatically;
  `learn_stats` showed 1 candidate, 0 promoted. Revalidate against
  current source before considering it authoritative.

## Incomplete V1.0 criteria

No controlled full GPT+old Dev versus GPT+Synrex same-model/same-task
benchmark establishes the target 20% median speed/call reduction or 50%
manual intervention reduction. The published deterministic governance,
semantic and learning fixtures are not substitutes for this test.
New actual **ChatGPT conversation** handoff, lost acknowledgments of
non-idempotent remote writes, network partitions and a deliberate healthy
rollback drill remain to be separately exercised. Synrex cannot wake
ordinary ChatGPT reasoning after the host turn ends.

See [`docs/SYNREX_V1_EXECUTION.md`](../SYNREX_V1_EXECUTION.md) for
the planned paired-task matrix and reproducibility requirements.
