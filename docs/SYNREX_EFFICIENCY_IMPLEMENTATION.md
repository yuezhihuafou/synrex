# Synrex V1: deterministic efficiency work

Status: source implementation; production activation must be verified separately.

## Evidence and non-regression contract

The 2026-10-21 GPT-driven V1 run completed 215 tool calls over ~62.2 minutes.
The sum of MCP tool handler durations was ~70.3 seconds. That figure excludes
background task time and GPT reasoning, and cannot be subtracted from elapsed
wall time to infer exact model latency. The trace includes 103 exec_command,
45 read, 25 task_get, 17 project, and 15 apply_patch calls.

Model reasoning and software quality are not optimized away: GPT retains
selection of evidence, architecture, edits and interpretation. Do not replace
requested source with summaries; do not silently change test targets, auto-retry
uncertain writes, infer safety of side effects, or remove final acceptance.

## Implemented first slice

- `read` accepts either its unchanged legacy `path` with optional `offset` and
  `limit`, or `files` of 1-8 explicit path/range objects. Reads fan out with
  at most four concurrent operations, preserve input order, original text,
  exact paths and independent failures. The coordinator fans out to existing
  single-file `read` v1 on an older peer; no gateway rollout is necessary for
  compatibility. A partial batch failure is visible as a tool error, but all
  successful file contents remain available.
- `pnpm verify:focused <explicit test paths>` executes only the selected
  development regression tests; it cannot silently choose or exclude tests.
  `pnpm verify:final` concurrently runs independent type and architecture
  checks, then the complete test suite; add `--build` for a subsequent full
  production build. All subprocess output flows to the durable Synrex run log;
  a structured terminal summary reports each step and exit status.
- The live MCP instruction text now requests parallel reads, bounded task
  waits and verified milestones rather than repeat `project` approval or
  `workflow_checkpoint` calls after routine edits. No authorization boundary,
  command scope or validation implementation has been removed.

## Known limits and next iterations

- This is a deterministic execution improvement, not a second planning model.
  It cannot cause ChatGPT to continue a finished ordinary conversation.
- Verification has no cross-run cache yet. Adding one requires a trustworthy
  input fingerprint including uncommitted changes, dependencies and environment;
  a repeated command string is not enough to prove a valid cache hit.
- More advanced parallel builds or speculative tool execution can introduce
  nondeterminism or side effects; do not enable them by default.
- Measure real host-side model/wall latency only if the host exposes it.
  Compare paired T1-T5 coding tasks on the same model, effort, environment and
  starting Git state. Record actual successes, tests, retries, tool calls,
  input/context size, human interventions and recovery; never claim estimated
  efficiency savings as achieved results.
