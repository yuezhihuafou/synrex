# Three-generation DevSpace / Synrex comparison — direct 2026-10-22 pilot

**Three actual ChatGPT MCP connections were invoked in the same turn:**

1. **Open source:** `DevSpace_Original_v1_0_8`, Waishnav/devspace tag `v1.0.8`, Git `fe712e2`.
2. **Intermediate:** `Dev_Baseline_T1_T5`, isolated October 20 `20261020-synrex-perf-v1`, already modified Synrex-derived code.
3. **Current:** `Synrex`, swy1 immutable production `20261022-synrex-v1-recovery-3367d6a`, Git `3367d6a`.

This compares **three different generations**, not three configurations of one unchanged repository. Product features unavailable upstream are recorded as structural capability differences, *not* upstream failures on a deliberately impossible task. Current GPT mode, exact hidden model effort, token use and internal model time were not supplied by the host.

## 1. Real MCP coding I/O — actual three-way execution

Each model-host tool connection opened an isolated worktree under its own authorized roots; a shared three-line fixture `mcp-three-way-fixture.txt` was written using the actual `apply_patch`, read back through the actual `read`, then verified using `exec_command` (`sha256sum` plus `git status`). All three passed and produced identical content SHA-256:

`4fdbc441ea7b546100e086ac1e4fc5ae6749b7314311c99db05be450eca12996`.

| Observed operation | Original | October 20 | Current Synrex |
| --- | --- | --- | --- |
| Real `open_workspace` isolated worktree | Pass | Pass | Pass |
| Real `apply_patch` same 3-line input | Pass, observed client 3487 ms | Pass, 3241 ms | Pass, 4686 ms |
| Real `read` same file | Pass, 1333 ms | Pass, 1133 ms | Pass, 1110 ms |
| Real checksum command and git status | Pass, 2680 ms | Pass, 2799 ms | Pass, 2221 ms |
| Five-second shell command | Pass, older process `sessionId` | Pass, durable global task ID | Pass, durable global task ID |

The call times above are `Date.now()` **around host-to-MCP tool invocation**, not server handler latency; they include variable network, host execution and orchestration. This is *not* a repeated randomized statistical benchmark.

## 2. Controlled small-command transport pilot

Six serial `/bin/true` real MCP calls per connection, alternating forward/reverse arm order, 18/18 exit 0. Direct host invocation timings (milliseconds):

| Connected variant | n | Mean | Median | Range |
| --- | ---: | ---: | ---: | ---: |
| Pristine upstream v1.0.8 | 6 | 3088 | 2950 | 2450–4145 |
| October 20 intermediate | 6 | 3453 | 3543 | 1778–4920 |
| Current Synrex | 6 | 5678 | 5727 | 2215–9401 |

**Important negative result:** in this small host-to-tool invocation sample current Synrex appeared **slower**, not faster. Do not attribute the delta to source implementation without isolating public HTTPS tunnel, ChatGPT host scheduler, service instrumentation, model context effects and host placement. This is a diagnostic signal, **not** proven coding-task slowdown or speedup.

For comparison, a separate **localhost HTTP health endpoint** test (100 warm sampled requests per original/current arm, alternating order; run `run_20261022071711_80ecfb6e`) showed original median 0.322 ms, current median 0.304 ms. It does **not** explain multi-second ChatGPT tool invocation timings.

## 3. Service restart and durable task identity

- Pristine original: launched `sh -c 'echo OLD_RESTART_START; sleep 13; echo OLD_RESTART_FINISH'`, received `sessionId=9` and start output. Restarted only its isolated `devspace-original-upstream-v108-test.service` using independent systemd timer `devspace-upstream-v108-recovery-test.service`. Restart unit `Result=success`, `ExecMainStatus=0`, original health 200 after restart, production Synrex health200. Attempt to resume the old session returned **`Unknown process session: 9`**. This proves the old **session handle did not survive restart**; it does not by itself prove whether the underlying shell process completed its side effect.
- October 20 intermediate: earlier connected T5 isolated service restart `task_cb63d34ac08c4d51`, `run_20261022065850_21acdc3c`, final `completed` exit0 under original durable task ID.
- Current Synrex: earlier gateway peer `devspace.service` restart while `task_cea6054f6fcf4d37d5c497c392e016ff` ran; old task ID recovered and terminal exit0, PID changed 1183883 → 1498416.

**Result: a verified recovery-capability advantage for both modified generations over pristine upstream's old process-session handle.** Topologies are not identical; do not claim an identical-mode restart reliability probability.

## 4. Feature, governance and operability coverage

The upstream `v1.0.8` Git tree did not contain `src/multinode/router.ts`, `src/workflow-store.ts`, `src/learning-store.ts`, `src/architecture.ts`, `src/ui/console-app.tsx` or `src/benchmark-metrics.ts`. Current pinned source does; that is architecture and API evidence, not a whole-task efficacy result.

| Area | Original open source | October 20 derived build | Current Synrex |
| --- | --- | --- | --- |
| Workspaces / read / edit / shell | Available and exercised | Available and exercised | Available and exercised |
| Retain shell task ID through service restart | Original process session lost | Observed success | Observed success |
| Multiple execution peers | Not included in original source | Later-generation architecture | swy1/gateway observed online, tool contract 17/17 in earlier live checks |
| Named cross-chat workflow checkpoints | Not in original source | Part of later-generation interface | Actual chat-to-chat checkpoint recovery previously verified |
| Learning candidate recall / promotion | Not in original source | Later-generation interface | Mechanism benchmark prior run 2/2 passed; impact on true GPT task outcomes **not yet proven** |
| Architecture boundary checking | Not in original source | Later-generation interface | Prior 6-case engine fixture: 4 correct blocks, 2 correct allows, no false-positive in those cases |
| Standalone Console | Not in original source | Intermediate release-dependent | Console and authenticated release smoke previously verified |
| Fault uncertainty on non-idempotent remote writes | Not in original source | Later-generation tests | Deterministic failure simulation covered; **real WAN ambiguous write remains open** |
| Long-run GPT token/time effectiveness | Unknown | Unknown | Unknown |

### Connected learning and architecture probes, not just source existence

Using the **actual connected intermediate and current MCP `project` tool**:

| Probe | October 20 intermediate | Current Synrex |
| --- | --- | --- |
| `learn_stats` | 6 episodes, 6 marked successful, 0 candidates, 0 promoted | 2,000 episodes, 1,752 marked successful, 1 candidate, 0 promoted |
| `arch_validate` | 0 errors, 0 warnings | 0 errors, 0 warnings |

The two learning stores have profoundly different accumulated history. The
counts show persistence/accessibility, **not** relative model quality,
effectiveness, correctness of all success labels, or justified growth rate.
The intermediate and current checks both succeed, so this small probe does
not establish a current-versus-intermediate governance quality difference.
Pristine upstream v1.0.8 does not expose a corresponding `project` action.

## 5. Source and regression reproducibility

- Original original-version exact-lock `npm ci` and `npm run build`: passed. Original 41 of 41 non-sandbox test scripts passed; one additional network-namespace `bwrap` sandbox case could not run due host permission denial. Do not call that a product regression.
- Current checkout `pnpm -s test`: 304 tests passed, 0 failed, 1 skipped (run `run_20261022070845_f6421f27`). Suites differ; raw test-count comparisons are invalid.
- Git diff original tag → current deployed source: 295 changed paths, +37,203/-11,125 lines; 113 upstream versus 225 current tracked `src/` files. **Code volume is not quality, reliability or efficiency.**
- October 20 versus current true old-Dev GPT T1–T5 single trial previously produced 5/5 success on both, code tree identical for T1–T3; it was **not pristine upstream**, not a blind/repeated speed study, and should not be projected onto this three-generation comparison.

## Verdict, limitations and priority

**Delivered capabilities and restart continuity visibly improve** from pristine upstream to current Synrex; baseline coding primitives still pass in all three variants. Conversely, the small observed host-to-tool call timings raise a **performance investigation** rather than demonstrating any faster GPT coding. The added learning/architecture/console modules do not prove higher end-to-end programming productivity without repeated blind tasks, intervention counts and wall-clock host instrumentation.

Next: measure per-tool/server-side ingress/dispatch/handler latency against the three separately launched services; use matched fresh task fixtures with controlled complexity, equal warm/cold setup and counterbalanced task order. For original-vs-current throughput and value claims, prefer end-to-end completion and falsifiable hidden tests over product-feature counting.

Test variants and their isolated worktrees were preserved. No production deployment or user source checkout was overwritten in this pilot.
