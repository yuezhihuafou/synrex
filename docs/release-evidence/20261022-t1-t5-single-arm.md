# T1–T5 actual-task pilot, 2026-10-22

Classification: **Synrex-only empirical engineering pilot**, **NOT** a
paired comparison against GPT + original Dev. Do not compute an improvement
percentage from these rows. This run uses one visible ChatGPT conversation
and the connected current Synrex MCP; no independent older Dev ChatGPT
connector or host-level identical model/effort recording was available.

## Fixed test conditions

- Owner source: current pinned production `20261022-synrex-v1-recovery-3367d6a`.
- T1–T3 isolation: `ws_0d92d61ad1`, source commit
  `cbcf1df20170a46910910f2ce5afbb0312651008`, isolated checkout
  `/home/swy/.devspace/worktrees/DevSpace-7d956279`.
- The final experimental edits live only in the isolated worktree commit
  `b33d66b42921e50309729b1d2d4dfd7789ff918a`; they were not merged
  or deployed to production.
- Gateway peer T5: connected gateway workspace
  `ws_31b78748e6dc0bf631bb`, independent from swy1 owner.

| Case | Task and independent verification | Actual outcome |
| --- | --- | --- |
| T1 bug fix | Add regression for accepting negative/non-finite optional token metrics. Initial `run_20261022062516_96f3158e` failed 1/9 as expected; add validation and rerun | `run_20261022062530_26a3e261`: 9/9 pass |
| T2 cross-file feature | Add `contextMeasurementRuns` summary field with tests for 0/1 instrumented records; typecheck | `run_20261022062546_08ce1ec5`, task `task_a783f81f035746b3`, terminal exit 0; 9/9 tests pass |
| T3 architecture refactor | Extract pure median into new `src/benchmark-statistics.ts` and new test, preserve report behavior, typecheck and project architecture | `run_20261022062608_1b3d373c`, task `task_05edbae4c133466c`, terminal exit 0; 10/10 tests pass, 0 architecture errors/warnings |
| T4 durable command | Run 9-second `sleep` with start/end markers asynchronously in isolated Synrex worktree | `run_20261022062627_610f6eb9`, `task_78baafefc95240d3`, completed exit 0 with original task identity |
| T5 restart recovery | Run 22-second gateway durable shell command while independently scheduling `systemctl --user restart devspace.service` after 2 seconds | `run_20261022062638_422c3afa`, `task_cea6054f6fcf4d37d5c497c392e016ff`, completed exit 0; PID changed **1183883 → 1498416**, restart unit `Result=success`, `ExecMainStatus=0`. Receipt shows 16 bytes and two output lines; these are the two expected begin/end markers. |

The durations above are *command/suite workload durations or receipts*, not
fully instrumented GPT start-to-final-verified-task wall times. Host model
thinking time, exact context and actual old-Dev tool calls remain missing.
The gateway service-restart experiment is real, but is not a network
partition or ambiguous external side-effect experiment.

## Honest comparison state

Matched original-Dev versus Synrex GPT samples: **0 / 5**.
Synrex single-arm task outcomes: **5 / 5 passed** under the specified checks.
The older Dev release binaries exist on disk, but invoking old code for
shell tasks cannot stand in for a second *ChatGPT using old Dev* agent run.
No time/tool-call/intervention improvement is asserted. A valid paired
comparison requires an independent original-Dev ChatGPT tool connection or
host-supported model/tool configuration, identical starting SHA and task
inputs, explicit model/effort, independent verification and measured total
host turns/time for both arms.
