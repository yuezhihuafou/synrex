# Synrex Task Continuity V1.1–V1.3: scoped implementation and acceptance

Status: **isolated source candidate, not a production-release receipt**. Do not
identify this document, the current checkout HEAD, or a successful unit test as
proof of a completed ordinary-ChatGPT end-to-end task.

## Product and deployment boundaries

- Ordinary ChatGPT remains the sole inference/reasoning Host. No Codex runner,
  model API, extra agent, job daemon, database service, or infinite MCP request.
- Existing SQLite workflow store, command/task receipts, stable workspaces,
  MCP tool schema and `src/ui/workspace-app.tsx` are reused.
- Source changes use an isolated worktree. Immutable swy1 production and OAuth
  state are not edited by source QA. Release requires a separately verified
  build, authenticated MCP/Host evidence, owner-state backup and reversible
  activation against the actual running release.

## P0 — Goal Finish Gate and task correctness

1. A test observation includes its original executable command, source,
   exit status, run/task or process-session handle, workspace/cwd/node alias,
   verification scope and a Git-content fingerprint. Old evidence without
   trusted provenance or a fingerprint remains readable but cannot silently
   prove a new acceptance criterion.
2. `criterionEvidence` only passes when the command matches the requested
   machine-verifiable check, is successful, has fresh content evidence and is
   not being reused for another criterion. Functional UX or deployment claims
   remain `requires_confirmation`; `checks` and `completedSteps` are notes.
3. Git tree, dirty changes and untracked file content are combined, so a
   second edit to an already-dirty source file invalidates old evidence. A
   path-specific check uses its test file, nearby implementation, actual
   working directory, bounded transitive relative imports and dependency
   manifests; a general check uses the code/dependency scope. Unknown or
   oversized import graphs fail closed. This is not a complete package/alias
   dependency verifier.
   For asynchronous tests, the fingerprint is captured when the trusted
   `exec_command` receipt is first observed, not when a later `task_get`
   reports success; edits during a running test invalidate that evidence.
4. Active durable tasks, input-required work, TTY sessions, cancellation and
   unknown outcomes are represented separately. Unconfirmed tasks without a
   `taskId` still block finish. A stale running observation is shown as
   `unknown`, never silently promoted to completed. Terminal receipts cannot
   be reverted by old polling observations.
5. Evidence persistence is **best effort** around primary tool operations.
   A SQLite error produces `continuityWarning` without falsifying the already
   completed patch or command result. Never replay a possibly applied write
   simply to repair auxiliary recording.

## P1 — Routine integration

- For substantial multi-file work, repeated diagnose/fix/test, deployments or
  work likely to cross replies, server instructions ask GPT to call
  `workflow_open` once with original goal and observable acceptance.
- After selection, normal tool calls with the same Host session/workspace
  automatically collect command/edit evidence. Simple tasks keep the original
  direct tool path. Expiring session bindings refresh when near expiry;
  recovery across conversations requires the precise `workflowId`.
- Ordinary success returns its original response; a concise continuation line
  is emitted only for verification milestones and abnormal outcomes. GPT is
  advised to execute the next authorized step, not just save checkpoints.

## P2 — Resume contract and unresolved Host acceptance

- The existing workflow card submits an explicit `workflowId` using the MCP
  message bridge, then the ChatGPT-specific follow-up bridge if available.
  The copyable recovery instruction is retained as fallback. A bridge's
  success response is **not** proof that GPT began working.
- `workflow_open(workflowId)` and `workflow_status` return the original goal,
  acceptance, saved steps, independently verified criteria (if any), current
  Git state, outstanding task/process handles and next action. The caller must
  inspect live receipts and files before replaying writes.
- On explicit resume/status inspection only, query up to 32 unresolved live
  Task/TTY handles. Terminal receipts supersede old `running` events for the
  handoff; missing or mismatched receipts remain `unknown`. Confirmed terminal
  tasks no longer remain blocked by stale checkpoint IDs. This is read-only
  live reconciliation, not a replay or a new background polling service.
- The existing ChatGPT connector successfully resumed this workflow by its
  explicit ID and returned its original goal and live Git discrepancy. This
  verifies manual-ID recovery transport, not the candidate App button's
  automatic `ui/message` follow-up behavior.
- **Still required:** manually click "继续任务" in the real, supported ordinary
  ChatGPT Host, and verify a real follow-up GPT turn and correct workspace
  restoration. If the Host rejects the message bridge, verify the copy-and-
  paste fallback. Source tests cannot establish this Host behavior.

## P3 — Cost and compatibility

- `taskContinuity.enabled` defaults to `true`; setting it to `false` disables
  new observational receipt augmentation only, leaving commands and workflow
  tools available. Configuration Schema is regenerated.
- Evidence lookup is bounded to recent events, unresolved handles and exact
  criterion IDs. Current state is queried separately from historical events;
  original run logs remain the primary command-output archive.
- A saved checkpoint opportunistically prunes terminal evidence older than
  90 days when outside the latest 512 receipts and not referenced by current
  acceptance. Unresolved work and referenced evidence are never pruned.
- Cross-conversation and cross-workspace isolation is retained by explicit
  workflow ownership and a hashed Host session binding. No implicit
  "newest workflow in directory" binding is allowed.

## Local verification and measured overhead (2026-11-17, swy1)

The isolated worktree passed `pnpm build` (exit 0) and the TypeScript check
`pnpm exec tsc --noEmit -p tsconfig.json` (exit 0). Targeted continuity,
integration and instruction regression suites passed (latest focused run:
19/19). An independent MCP server/OAuth integration run passed 65/65.

The full-suite first pass had 465 tests, 455 passes, 8 failures, 2 skips;
the subsequent pass had 466 tests, 460 passes, 4 failures, 2 skips. Three
failures in the second pass were obsolete string expectations in Host MCP
instruction tests, subsequently corrected and verified by the 65/65 targeted
MCP run. The remaining failure occurred in the unrelated Pi sandbox test on
this host: `apply-seccomp: write /proc/self/setgroups ... CAP_SYS_ADMIN:
Permission denied`. This is an environmental capability restriction, not
evidence that the nested sandbox integration works. A clean complete suite
remains a release gate. **Final full run:** `pnpm test` on this isolated worktree
reported **468 tests: 465 pass, 1 fail, 2 skip** (126.54 s). The sole failure
is the same Pi sandbox capability restriction. The complete suite was executed,
but it did **not** pass; do not label it green or waive this environment issue
as proof of sandbox compatibility. Detailed log:
`/tmp/synrex-v11-final-full.log` (on swy1).

Local direct receipt-function benchmark (100 calls per mode, ephemeral SQLite
workflow, no network, 8 warm-ups) measured:

| Mode | p50 | p95 | Mean JSON response size |
| --- | ---: | ---: | ---: |
| Disabled enhancement | 0.000 ms | 0.002 ms | 80 bytes |
| Enabled, ordinary successful command | 3.378 ms | 4.754 ms | 124 bytes |

These are **local microbenchmarks** measuring an enhanced receipt versus a
disabled fast path. They are not GPT tool-call, inference latency or Token
cost measurements. Real Host before/after completion rate, early stops,
manual continues and total Token consumption remain unmeasured.

## P4 — Evidence requirements before enabling a new production release

**Additional measured run:** With a kernel-capability-aware Pi sandbox test,
`pnpm test` reported 468 tests: **465 pass, 0 fail, 3 skip**; the 11 subsequent
script tests passed. The sandbox test was skipped because nested
`apply-seccomp` user namespaces are forbidden on this swy1 host; it correctly
**fails** with `DEVSPACE_REQUIRE_PI_SANDBOX=1`. The explicit security gate still
requires execution on a supported host. Log:
`/tmp/synrex-continuity-v13-full-20261117.log`. A further full regression is
required after the later live-handle reconciliation and async-test fingerprint
changes; the focused integration tests pass.

**Latest complete source regression after those changes:** `pnpm test` exited
zero with **471 tests: 468 pass, 0 fail, 3 skip**, followed by **11/11** passing
script tests. Log: `/tmp/synrex-continuity-v13-verified-full.log`. One of the
three skips remains the host-restricted Pi sandbox; the result must not be
interpreted as successful sandbox enforcement on swy1. The new cases include
late durable task/TTY reconciliation, checkpoint task receipts outside recent
history, and code edits during an asynchronous verification.

Local source tests establish the deterministic store and MCP handler behavior,
not ChatGPT's inferred decision policy. Keep these measurements distinct:

| Scenario | Deterministic proxy | Real ChatGPT Host |
| --- | --- | --- |
| Failed test then repair | command/evidence status regression | not yet tested |
| Build passes, acceptance remains | unrelated evidence and manual-criterion tests | not yet tested |
| Long-running execution | detached-task and untracked TTY tests | not yet tested |
| Reply interruption/resume | explicit handoff/Git mismatch integration | not yet tested |
| Concurrent conversations | workspace/session selection tests | not yet tested |

Completion rate, early-stop count, manual "continue" count, Host recovery
rate, end-to-end total tokens, and before/after tool usage must remain
**unmeasured** until comparable real Host tasks are recorded. No fabricated
values or promotion solely from passing TypeScript tests.

## Recovery and rollback

For a suspected incompatibility set `taskContinuity.enabled=false` in the
versioned config and restore the previously pinned release if needed. Use the
existing owner-state backup script and activation health/rollback checks for
production changes. Never overwrite a release directory or force-push main.
