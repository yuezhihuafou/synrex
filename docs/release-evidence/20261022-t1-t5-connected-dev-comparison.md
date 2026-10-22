# Connected GPT + Dev versus GPT + Synrex T1–T5, 2026-10-22

The user installed and authorized `Dev Baseline T1-T5` in ChatGPT. The
ordinary ChatGPT host exposed both tool namespaces (`Dev_Baseline_T1_T5` and
`Synrex`) in the same conversation, so the following are **actual calls to
both MCP servers**, not a fake baseline or Codex CLI stand-in.

Both code worktrees began at Git SHA
`cbcf1df20170a46910910f2ce5afbb0312651008` and received the same
T1–T3 feature changes. Old Dev worktree `ws_7a0b7e0481` and Synrex
worktree `ws_0d92d61ad1` were isolated. Old Dev initially lacked the
`pnpm` executable in PATH and its fresh worktree lacked dependencies;
an offline frozen pnpm install restored a runnable test environment. This
setup incident is not model failure; it does contribute an environment
intervention and means the two arms did not have fully identical warm setup.

| Task | Connected original Dev result | Earlier connected Synrex result |
| --- | --- | --- |
| T1: test-first bad-token benchmark input fix | Initial test run `run_20261022065637_5daf403b` 8/9 pass, expected regression failure; corrected run `run_20261022065751_2fdb750d` 9/9 pass | Initial regression failure `run_20261022062516_96f3158e`, corrected `run_20261022062530_26a3e261` 9/9 pass |
| T2: cross-file `contextMeasurementRuns` | `task_ff8db851b1304c4f`, run `run_20261022065806_71ed0ce4`: 9/9 pass, typecheck exit0 | `task_a783f81f035746b3`, run `run_20261022062546_08ce1ec5`: 9/9 pass, typecheck exit0 |
| T3: median module refactor | `task_0e0d3ca158e741df`, run `run_20261022065833_4ed71e03`: 10/10 pass, typecheck exit0; architecture check 0 errors/warnings | `task_05edbae4c133466c`, run `run_20261022062608_1b3d373c`: 10/10 pass, typecheck exit0; architecture0/0 |
| T4: durable 9 s shell command | `task_2ff37ea118804478`, `run_20261022065842_45dd8234`, completed exit0 | `task_78baafefc95240d3`, `run_20261022062627_610f6eb9`, completed exit0 |
| T5: durable 22 s job through service restart | Isolated old Dev `task_cb63d34ac08c4d51`, `run_20261022065850_21acdc3c`, completed exit0; independent `synrex-benchmark-old-dev-t5-restart.service` Result success / ExecMainStatus0, old Dev health200 afterwards | Remote gateway `task_cea6054f6fcf4d37d5c497c392e016ff`, `run_20261022062638_422c3afa`, completed exit0; gateway service restarted with PID change |

Code produced by T1–T3: old Dev commit `ee920a2` and Synrex commit
`b33d66b`, both rooted at the above base SHA, have exactly the same
**Git tree ID** `de8125f148e01da6558fa79e963a76c705b6fb44` (verified
using `git rev-parse`). So both arms delivered equivalent *final artifacts*
and passed the same stated targeted checks.

## Limits for the performance inference

- This was one observed run for each task per arm, not the previously proposed
  five repeats per task. Task executions occurred sequentially, not in a
  randomized or counterbalanced order.
- Both tool connections were genuinely exposed to the same ChatGPT
  conversation; however, the host did not expose exact per-task GPT reasoning
  duration, token consumption or complete tool-request duration by arm.
  Therefore **no reliable paired GPT wall-time delta or token difference**
  can be calculated. The run identifiers and durable shell durations are
  evidence of execution, not substitutes for reasoning/total task time.
- The old Dev worktree required environment setup. Both T5 jobs recovered,
  but Synrex tested a gateway peer while old Dev tested its isolated swy1
  local service. These are real recovery demonstrations, **not an exactly
  matched topology experiment**.
- The same GPT conversation had already seen Synrex code changes, so T1–T3
  old-Dev arm may benefit from carryover. They are useful functional parity
  measurements, not independent blind agent quality samples.

Observed paired functional outcome under the stated checks: **5/5 both
passed**, with 0 cases of one arm uniquely succeeding. Code tree identity
was verified for T1–T3 only. Performance winner: **undetermined**.
