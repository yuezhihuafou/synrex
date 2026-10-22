# Upstream DevSpace v1.0.8 versus pinned Synrex: source and execution audit

Date: 2026-10-22. This document explicitly **supersedes** using the locally
modified `20261020-synrex-perf-v1` as the *original upstream* control. That
binary was an earlier **Synrex-derived** release, not pristine open source.

## Version identities and comparison design

- Original open-source project: `Waishnav/devspace`, package
  `@waishnav/devspace`, upstream annotated tag `v1.0.8`, source Git SHA
  `fe712e2b6c07231d2a76503bf2a674b165850616` (2026-08-26).
- Its independent source worktree: `ws_1425f66d76`,
  `/home/swy/.devspace/worktrees/DevSpace-19817826`.
- Current **production** Synrex source SHA
  `3367d6a3b4e577a1846172af58c7e7f086e521d7`, immutable release
  `20261022-synrex-v1-recovery-3367d6a` on swy1. Subsequent Git commits
  are development/test documentation, not silently promoted production.
- Controlled comparison requires equal project inputs, model and effort,
  cold/warm dependency setup, host, transport, repetitions and verifier.
  Functional coverage from each version's own test suite is **not** a
  matched end-to-end model task benchmark.

## Source and capability inventory

`git diff --shortstat v1.0.8 3367d6a` reports 295 changed paths,
37,203 insertions and 11,125 deletions. Source file inventory is 113
under `src/` for upstream and 225 for Synrex. This is code churn, not a
quantitative quality or productivity measure.

| Dimension | Upstream v1.0.8 | Synrex pinned source / deployed service |
| --- | --- | --- |
| MCP coding primitives | Workspace open/read/edit/command/review tools present | Retained plus modified interfaces, connected through ChatGPT |
| Model-led coding | External MCP conversational host | External GPT-first conversational host; no autonomous host wake |
| Multi-host remote routing | No `src/multinode/router.ts` | `src/multinode/router.ts`, link hub and worker peers; swy1 + gateway live with 17/17 contract compatibility in earlier production checks |
| Durable named cross-chat workflows | No `src/workflow-store.ts` | Persistent workflow APIs; actual new-chat checkpoint recovery verified |
| Evidence-based learning | No `src/learning-store.ts` | LearningStore and candidate governance; 5/5 deterministic capability fixtures previously passed |
| Architecture governance | No `src/architecture.ts` | Architecture contracts and validation; 6/6 controlled engine fixtures previously passed, 0 false-positive blocks in those six fixtures |
| Standalone management console | No `src/ui/console-app.tsx` | Dedicated console app and authenticated snapshots |
| Paired benchmark summary | No `src/benchmark-metrics.ts` | Benchmark statistics including missing-control handling; no invented GPT speed claim |
| Recovery under actual owner/peer restart | Not tested in this audit | Synrex durable task completed through real gateway service restart in earlier T5 |

These file-existence findings are verified against the two Git trees; they
are evidence for different architecture boundaries, **not** evidence that
the upstream implementation is defective or that every new module adds value.

## Test runs: keep different test definitions distinct

- Synrex current development checkout `pnpm -s test`, task
  `task_03cbdf56e32848d9`, run `run_20261022070845_f6421f27`, **304
  passed, 0 failed, 1 skipped**, duration 84,368 ms. Source checkout at
  that time differed from pinned production only by subsequent commits.
- Original upstream ran `pnpm exec tsx src/roots.test.ts && ...
  src/apply-patch.test.ts && ... src/review-checkpoints.test.ts && ...
  src/config.test.ts`; run `run_20261022071027_80931856` **exit 0**.
- An initial attempt to run original `pnpm test` failed in
  `src/process-sessions.test.ts`: the optional `node-pty` module was
  unavailable because build hooks had been blocked by the dependency
  manager. This is an **environment-invalid** run, not a functional
  comparison showing regression in the open-source Dev.
- An initial `pnpm build`/TypeScript check of original source failed due to
  dependencies resolved from new pnpm semver ranges: the original
  `package-lock.json` pins Pi SDK `0.80.3` and Claude SDK `0.3.200`, but
  unconstrained pnpm installed Pi `0.80.10`, with incompatible API surface.
  This too is an **environment-invalid** result.
- Exact upstream package-lock install **completed successfully** with
  `npm ci --registry=https://registry.npmjs.org --no-audit --no-fund`, task
  `task_8675fd0bcd054923` exit 0. Original SDK version restored; original
  `npm run build` passed in task `task_34c84c4fd28f4fb4`, run
  `run_20261022071420_c4117ea4`.
- With upstream-locked dependencies, the unchanged original `npm test`
  still stops on `src/local-agent-pi-sandbox.test.ts` because host
  `bwrap` cannot create the sandbox loopback interface:
  `Failed RTM_NEWADDR: Operation not permitted`. That is a host namespace
  permission restriction, **not** an observed upstream code defect.
- A separate original test sweep excluded only that sandbox-specific test
  file. **41 of 41 other original test scripts passed**, exit 0, task
  `task_40689c274d3d4259`, run `run_20261022071458_af726737`.
  The original suite therefore has substantial working coverage, but
  missing the 42nd file precludes claiming unqualified 100% full-suite pass.

## Live original upstream versus production health

- Started original upstream v1.0.8 in independent user systemd unit
  `devspace-original-upstream-v108-test.service` on **loopback port 8771**.
  It uses a freshly generated owner secret, separate SQLite state, config
  directory and worktree directory under
  `/home/swy/services/devspace/bench-upstream-v108`; its owner secret was
  not printed. Original HTTP `/healthz` returned **200** and anonymous
  `/mcp` returned **401**, as designed.
- Pinned Synrex production owner remains on port **7676** with health 200.
- For an actual independent ChatGPT original-upstream arm, started a separate
  HTTP2 Cloudflare test tunnel (`devspace-upstream-v108-tunnel.service`) and
  configured v1.0.8's distinct OAuth issuer
  `https://nearest-hung-diet-vice.trycloudflare.com`. Public MCP endpoint:
  `https://nearest-hung-diet-vice.trycloudflare.com/mcp`.
  Public health **200**, OAuth discovery **200**, unauthenticated MCP **401**
  verified in `run_20261022071839_5c120bff`. This URL is temporary and
  its custom ChatGPT plugin has **not** been installed/authorized at the
  time of the report; therefore no upstream-v1.0.8 model-led coding trial
  has yet been performed.
- Alternating 100 timed serial HTTP `/healthz` requests per version after
  10 per-endpoint warmup requests, same machine Node fetch benchmark, run
  `run_20261022071711_80ecfb6e`:

  | Endpoint | Requests | Mean (ms) | Median (ms) | p95 (ms) |
  | --- | ---: | ---: | ---: | ---: |
  | Original upstream v1.0.8, port 8771 | 100 | 0.381 | 0.322 | 0.649 |
  | Synrex pinned production, port 7676 | 100 | 0.351 | 0.304 | 0.560 |

  The p95 delta is 0.089 ms in this one localhost health endpoint sample.
  This is **not** MCP task execution throughput, network tunnel delay,
  GPT model thinking time or a statistically established speed advantage.

## Interpretation and outstanding comparisons

1. The prior connected `Dev Baseline T1-T5` arm genuinely tested an older
   DevSpace service, **but not upstream v1.0.8**; its 5/5 result does not
   establish upstream baseline outcomes.
2. Presence of extra Synrex functionality, stable production health, and
   passing tests support delivered *capability differences*, not a measured
   end-to-end superiority claim. Baseline parity on the six shared tools and
   old-version fault behavior still require comparable fixture runs.
3. The original v1.0.8 has not yet been registered as an independent GPT
   plugin. Starting a local worktree or running its unit tests is not a
   same-model, same-context GPT coding trial.
4. End-to-end success, wall-clock, tool count, retries, host reasoning tokens,
   false positive blocks and incidents require multiple independently
   counterbalanced paired actual ChatGPT tasks. These values are **unknown**
   until tested; do not substitute shell/pytest microtimings.

## Non-interference

Upstream source work is confined to the detached worktree. The current
swy1 production service, OAuth authority and gateway deployment must remain
unchanged throughout this comparison. The older temporary comparison MCP
server from 2026-10-20 is distinct from this v1.0.8 source worktree. The
upstream test instance is a separate service, **not yet added as a
ChatGPT plugin**; local health and source tests must not be misrepresented as
original-v1.0.8 GPT tool-use trials.
