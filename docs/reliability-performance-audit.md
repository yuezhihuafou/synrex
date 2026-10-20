# Synrex reliability and performance audit

Status: working audit, 2026-10-01. This document records observed behavior and
testable hypotheses before implementation changes. It is intentionally separate
from architecture intent: findings should be reproduced before they become
design changes.

## Scope

Evaluate the current live Synrex as an agent execution system, not only as a
collection of features. Primary outcomes are:

- end-to-end task success and recoverability;
- host/server schema compatibility;
- correct multi-node placement and routing;
- durable-task liveness, cancellation, recovery, and notification semantics;
- semantic/LSP usefulness versus latency;
- model-context and transport overhead;
- governance/learning value without putting expensive work on hot paths.

## Confirmed observations

### Core local tool path is not the main latency source

2026-09-30 live logs on the gateway showed approximately:

- `read`: p50 ~1 ms, p95 ~2 ms;
- `apply_patch`: mean ~3 ms;
- `open_workspace`: p50 ~176 ms in the post-multi-node sample;
- `exec_command`: p50 ~148 ms, p95 ~2.04 s.

The current full regression run passed 199 tests with 0 failures (1 skipped),
and typecheck passed. Deterministic capability checks passed governance 2/2,
semantic 1/1, and learning 2/2. These checks prove mechanism behavior, not
end-to-end agent improvement.

### Host schema can lag the live server

The live schema probe reported 13 Codex tools and schema fingerprint
`0412f1e89b8ae34d616d`, while the already-open ChatGPT host turn still exposed
an older six-tool snapshot. The stale snapshot omitted the `open_workspace.node`
selector and durable-task control tools.

Consequences already reproduced:

- an ambiguous two-node `open_workspace` fails once because the host cannot
  express the node selector advertised by the live implementation;
- a long command may return a durable task handle while the stale host has no
  `task_get`/`task_cancel` tools to continue or recover it.

Candidate direction: add an explicit host/server capability or schema epoch and
define degraded behavior for older hosts. Deployment-time `tools/list` probing
is necessary but not sufficient because an existing host turn can retain its
old tool snapshot.

### Advertised skill paths are not always consumable

`open_workspace` can advertise a path such as
`~/.devspace/skills/subagents/SKILL.md`, but `read` currently may resolve it as a
workspace-relative literal `~/...` path. This produced an `ENOENT` in the live
path.

Required invariant: every model-visible `skills[].path` returned by
`open_workspace` must be accepted by `read` without the model having to rewrite
it.

### Remote node transport adds material latency

One observed remote `open_workspace` executed on the worker in ~126 ms while
the corresponding gateway-facing MCP request took ~1033 ms. The logical
workspace routing remains correct; the current long-poll worker transport adds
roughly sub-second-to-second latency in this observed path.

Candidate direction: preserve `NodeTransport` and workspace affinity semantics,
but evaluate a persistent bidirectional transport (for example WebSocket) with
request IDs, reconnect, backpressure, and the existing durable-task ownership
model.

### Semantic precision is useful but expensive

The deterministic capability benchmark found the intended semantic reference
while excluding text false positives, but the observed costs were roughly:

- plain grep: ~3 ms;
- semantic definition lookup: ~2.71 s;
- semantic reference lookup: ~5.12 s.

Candidate direction: cheap text/read first, invoke semantic queries on
ambiguity or when reference precision is needed; add readiness/warm-cache
measurements before deciding whether prewarming is worthwhile.

### Terminal task notifications accumulate

Opening the same Synrex checkout on the two current nodes surfaced large
unacknowledged terminal-task counts (about 290 and 84 in the observed calls).
Only a bounded subset is returned, but the backlog is still scanned and becomes
bootstrap state.

Candidate direction: distinguish task history from actionable notifications;
expire or compact old terminal notifications and scope proactive surfacing to
recent/relevant work.

## Durable-task investigation

The durable-task subsystem is now a priority reliability target because prior
interactive use has shown tasks that appeared to remain stuck.

Initial code-review risks to reproduce:

1. **Cancellation fallback hole.** Every task receives a systemd unit name. If
   user systemd is available, `cancel()` tries `systemctl --user stop` and then
   returns even when that stop command fails. If launch previously fell back
   from failed `systemd-run` to a detached runner, cancellation can therefore
   leave the real runner alive.
2. **`input_required` is not a complete execution protocol.** State and
   `task_update` exist, but the shell runner has stdin disabled and no
   bidirectional input channel is evident. A state transition alone cannot
   resume a command that is actually waiting for external input.
3. **Recovery only reconciles `working`.** `reconcileTask()` currently returns
   immediately for states other than `working`; a dead runner represented as
   `input_required` can therefore remain nonterminal indefinitely.
4. **Stale-launch detection has a grace window.** Before a runner PID is
   persisted, liveness can fall back to a 60-second heartbeat freshness window.
   Some launch failures can look `working` until later reconciliation.
5. **Active-marker reconciliation is bounded to 100 entries.** Corrupt or stale
   markers are deliberately retained. A sufficiently large/stale marker set
   may delay or starve reconciliation of later entries and make workspace open
   perform repeated liveness checks.
6. **State-write chain needs fault injection.** Runner state writes are
   serialized through one promise chain. We need to verify behavior after a
   transient state-write failure and ensure terminal state remains writable.

These are hypotheses/implementation risks until reproduced by tests below.

### Reproduced durable-task failures

The following failures were reproduced on 2026-10-01 with isolated fault
injection or observed directly in the live run store:

1. **Historical orphan remains permanently `working`.**
   `task_7369c4eb-718b-480d-a46d-501ed9b42a0d` from 2026-09-14 still has
   `status=working`, but its runner PID and child PID no longer exist, its
   transient systemd unit is gone, and `meta.json` is missing. Its task index
   remains while its active marker is absent. Because workspace reconciliation
   scans active markers rather than all nonterminal indexed tasks, this orphan
   is invisible to normal recovery and can remain `working` indefinitely
   unless a caller still knows the task ID and explicitly calls `task_get`.
2. **Cancellation can acknowledge without stopping the runner.**
   An isolated task with a live runner PID and a nonexistent systemd unit was
   passed to `cancel()`. The call returned, but the process remained alive
   (`aliveAfterCancel=true`). The systemd branch catches a failed
   `systemctl stop` and returns instead of falling through to PID
   cancellation.
3. **Dead `input_required` tasks do not reconcile.**
   An isolated one-hour-stale `input_required` task with a dead runner PID and
   nonexistent systemd unit remained `input_required` after `get()`, with no
   error and a 60-second poll interval. `reconcileTask()` only reconciles
   `working`.
4. **A transient state-write failure can poison all future task-state writes.**
   An isolated real runner was allowed to start, the task directory was made
   temporarily unwritable for one heartbeat, then made writable again before
   command completion. The runner produced terminal metadata, but the task JSON
   remained permanently `working`:
   `runnerReturn=1, finalTaskStatus=working, metaExists=true`.
   The serialized `stateWriteChain` remains rejected after one write failure;
   later terminal/failed state writes chain from that rejection and never call
   the atomic writer.
5. **The 100-active-marker bound can starve valid recovery forever.**
   An isolated workspace was given 100 unreadable active markers followed by a
   valid stale `working` marker. `pendingNotifications()` examined only the
   first 100 entries, retained all unreadable markers, and never reconciled the
   valid task: `statusAfterSweep=working`. A fixed prefix bound plus
   non-removal of corrupt markers is therefore not a safe recovery cursor.

### Notification backlog is both a scale and ordering problem

The live gateway run store currently contains roughly 4.3k task index records
and 888 unacknowledged terminal notifications. The sampled notification
distribution was 875 completed, 8 cancelled, and 5 failed; most belonged to
`/home/swy/ros2_ws` or `/home/swy/Synrex`.

`pendingNotifications()` sorts terminal notifications oldest-first, while
`open_workspace` exposes only the first eight. With a large backlog, newly
completed work is therefore hidden behind old terminal history. This can make a
completed task appear unresolved even when its terminal notification exists.
History and actionable notification state must be separated.

### Protocol compatibility concern

The 2026-07-28 MCP Tasks extension treats tasks as progressive enhancement:
task-augmented execution is negotiated through client capability, and clients
then poll `tasks/get` / update / cancel. Synrex currently also has a
compatibility tool layer, but a stale host tool snapshot can receive a new
durable task handle without having the compatibility control tools in that
turn. This creates a half-compatible state where task creation is durable on
the server but not operable by the actual host.

The desired invariant is stronger than "the live server exposes task tools":
**never return an asynchronous handle unless the specific host turn has a
verified continuation path for that handle.**

### Multi-node delivery can lose the recoverable task handle

The current long-poll transport marks a request delivered when a worker polls
it. A delivered request is not requeued until completion. An isolated
`NodeLinkHub` experiment confirmed:

`firstDelivered=true, redeliveredWithoutCompletion=false`.

For a remote `exec_command`, this matters because the gateway creates/binds the
global task ID only after the worker returns the tool result. If the worker
starts a durable task successfully and the link fails before the completion
POST reaches the gateway, the node-local task can continue while the gateway
never obtains the local task handle and therefore cannot create the global
task route. The pending gateway request eventually times out, and reconnect
does not currently redeliver or reconcile that delivered request.

This contradicts the intended property that network loss should not turn
node-local durable execution into unrecoverable host state. The transport needs
an acknowledged delivery/completion protocol or idempotent request journal,
plus reconnect reconciliation of in-flight requests and created task handles.

### Advertised subagent availability is not end-to-end health

An independent audit attempt through
`devspace agents run codex ... --json` failed with
`DAEMON_STARTUP_FAILURE`, even though `open_workspace` advertised the Codex
provider as available and `agents targets` returned it. A manually launched
compiled daemon can start and stop normally, so provider discovery alone is
not sufficient evidence that the complete daemon/CLI execution path is usable.

Required invariant: model-visible capability advertisement should distinguish
installed/configured from end-to-end healthy, or perform a bounded readiness
probe before presenting the capability as immediately usable.

## Additional mechanism findings, 2026-10-01

### Current repair branch fixes several earlier defects but is not closed yet

Uncommitted parallel changes now add cancellation fallback, orphan sweeping,
newest-first notification ordering/retention, state-write-chain recovery,
output backpressure, node request IDs, completion receipts, a source-checkout
daemon loader fix, and an old-host `devspace-task get/cancel` compatibility
path. Targeted tests confirm many of these directions, but the combined branch
still has a regression: the durable-task compact-wire test exceeds its existing
550-byte launch-response budget, and that failing test also exposed runner
activity continuing after fixture teardown.

### Cancellation still has a pre-PID race

The repair writes `cancel.requested` before attempting systemd/PID
cancellation, but the runner currently does not consume that marker. An
isolated delayed-launch experiment cancelled the task before the runner started,
then released the runner. The command still executed its side effect and
finished `completed`:

`runnerReturn=0, status=completed, sideEffect=true`.

Cancellation therefore needs to be part of the runner launch protocol, not only
a manager-side hint. The runner must check cancellation before spawning the
child and during startup, with an idempotent terminal transition.

### PID-only liveness can produce false-working tasks

`runnerIsAlive()` currently accepts `kill(pid, 0)` as proof of runner
identity. An isolated one-hour-stale task was assigned the PID of the unrelated
audit process; `get()` returned `working`. PID reuse can therefore keep a dead
task alive indefinitely. Store and verify runner identity stronger than PID
alone (for example process start time/boot id, process-group identity, or a
lease/generation token owned by the runner).

### Launch failure splits host state from durable state

When the launcher itself throws, `start()` has already persisted task/index/
active records but propagates the launch error without terminalizing the task.
The isolated result was:

`startRejected=true, indexEntries=1, stateStatus=working, pending=0`.

The host sees a failed tool call while the durable store temporarily claims
work is still running. Launch must be a state transition with a committed
failed terminal state on unrecoverable launch failure.

### Global orphan sweeping restores correctness at growing startup cost

The repair scans the global `.task-index` periodically for orphaned
nonterminal work. Synthetic measurements on the current implementation were
about 270 ms for 4,000 index files and 660 ms for 10,000 files. This is linear
in global task history and repeats per workspace sweep window.

Prefer a workspace-scoped nonterminal index/lease table so recovery cost scales
with active/recent work rather than all historical tasks.

### Remote mutating tools are not exactly-once across the receipt-commit gap

Worker completion receipts are persisted after a node tool returns. An isolated
fault injected a crash/failure at receipt persistence after a mutating tool
executed, then replayed the same node request. The tool executed twice:

`executions=2`.

Durable `exec_command` now has request-ID idempotency, but other mutating tools
such as patch/semantic edits still have an execute-before-receipt window.
Exactly-once cannot be guaranteed by a post-effect receipt alone. Mutating
operations need an operation journal/idempotency key at the tool boundary or
must explicitly expose at-least-once semantics and make operations replay-safe.

### Worker receipts do not reconcile after gateway state loss

A persisted completion receipt was placed on a worker, then the worker was
started against a gateway behavior with no pending request (the effective
post-restart state). Across eight polls the worker made zero completion attempts
and kept the receipt:

`polls=8, completes=0, receiptStillPresent=true`.

The worker only replays a receipt when the gateway redelivers the same request.
Gateway restart loses the in-memory pending dispatch, so reconnect currently
has no reconciliation handshake for stranded completions/task handles. Node
registration should exchange in-flight/completed request identities or the
gateway request journal itself must be durable.

### Architecture governance can be bypassed by committing intent directly

In an isolated Git repository, architecture intent was initialized, then
`.devspace-architecture.json` was modified directly without
`arch_change_open/close`. Before commit, conformance correctly reported
`uncommitted-architecture-change`. After committing the file directly,
conformance accepted it and returned no error:

`uncommittedBefore=true, uncommittedAfterCommit=false, errorsAfter=[]`.

The current seal treats a matching committed intent as trusted. Since the agent
has shell/Git authority, a commit is not an independent authorization boundary.
For governance to prevent agent-induced design drift, advancing the intent seal
must require a verified architecture-change record/transition, not merely a Git
commit.

Also note that ordinary source conformance is enforced at `show_changes`,
after writes have already landed in the workspace. This is useful post-hoc
verification but is still dependent on the host actually invoking the review
barrier.

### Learning promotion is evidence-labelled, not evidence-validated

An isolated learning store recorded one unrelated successful README read,
distilled an unrelated workflow containing a `skip tests` step, and promoted
it with `validationNote="looks good"`. The resulting skill was promoted and
contained that procedure:

`promoted=promoted, evidenceCount=1, containsProcedure=true`.

Current promotion validates only that a note exists and that evidence episode
IDs belong to the workspace. It does not bind evidence to the proposed
procedure or verify test/review/commit/benchmark artifacts. For automatic skill
induction, promotion should require machine-verifiable validation evidence and
provenance linked to the candidate procedure.

### Semantic backend freshness looks better than its cold-start latency

A real Serena experiment warmed a TypeScript workspace, renamed a symbol by
editing the file directly, and queried again. The old symbol disappeared and
the new symbol was visible immediately. Observed timings were roughly 2.24 s
for cold startup and ~100 ms for subsequent simple symbol queries.

This narrows the current semantic concern: prioritize cold-start, reference
query cost, readiness, and trigger policy rather than assuming stale-cache
correctness problems without evidence.

### Subagent daemon startup and provider execution are separate failure layers

The source-checkout daemon startup failure was reproduced and the parallel
loader repair now allows a Codex agent record to start successfully. A later
independent audit run then failed at the provider layer with a retryable stream
disconnect. Provider availability, daemon readiness, and turn execution should
therefore remain separate health states, and retryable provider failures need a
bounded retry/resume policy rather than being presented as equivalent to daemon
failure.

## Required experiments

- inspect real `.task-active`, `.task-index`, notification, task JSON, meta JSON,
  runner PID, child PID, and systemd-unit consistency on both nodes;
- launch/complete/cancel a normal durable task;
- cancel during the pre-PID launch window;
- force `systemd-run` failure and verify detached-runner cancellation;
- kill runner and child independently, then verify convergence to a terminal
  state;
- restart Synrex while a durable task runs and verify survival/recovery;
- restart the user systemd manager where safe in an isolated harness, not on the
  live service;
- inject stale/corrupt active markers beyond the reconciliation bound;
- inject state-file write/rename failures;
- test output flood/backpressure and bounded memory;
- test multi-node durable task routing across temporary gateway/worker link
  loss;
- measure task-state convergence time, false-working duration, cancellation
  latency, unrecoverable-task rate, and notification cleanup.

## Evaluation rule

Do not remove capabilities merely because they have overhead. Prefer fixing
contracts, recovery, transport RTTs, caching, and trigger policy. A feature is
kept only if controlled end-to-end experiments show a net task-success or
operability benefit at an acceptable latency/context cost.

## Candidate fixes implemented and verified

The current working tree now contains fixes for the reproduced failure modes.
They remain candidate changes until the full suite and live deployment path
complete.

### Durable task state and recovery

- cancellation writes a durable cancel marker, falls back from a failed
  systemd stop to process-group/PID termination, and handles cancellation
  before runner PID publication;
- both `working` and historical `input_required` states reconcile dead
  runners to a terminal state;
- orphaned nonterminal tasks are recovered from the durable task index even if
  their active marker disappeared;
- corrupt active markers are removed and no longer permanently starve a valid
  marker behind a fixed prefix;
- one failed task-state write no longer poisons every later write in the
  serialized write chain;
- stdout/stderr honor output-stream backpressure;
- PID recovery on Linux checks the command line so PID reuse cannot falsely
  keep an old task alive;
- launch failure commits a terminal failure instead of leaving a working
  ghost;
- terminal notifications are newest-first and old successful notifications
  expire independently of durable run history;
- task snapshots derive active/terminal state from the persisted state machine,
  not heartbeat freshness. Heartbeats remain liveness evidence used during
  reconciliation;
- the shell runner does not claim structured `input_required` resumption.
  `task_update` remains registered for schema/protocol compatibility but
  explicitly reports that no structured input channel exists.

### Orphan sweep cost

The first compatibility implementation scanned historical task indexes
serially. On the live gateway, 4,396 index entries took about 2.24 seconds.
A read-only benchmark over the same store measured:

- concurrency 8: ~134 ms;
- concurrency 16: ~119 ms;
- concurrency 32: ~125 ms;
- concurrency 64: ~137 ms.

The candidate implementation therefore uses bounded concurrency 16 and
backfills the workspace root into legacy index entries. New indexes already
store the root, so later workspace sweeps can reject unrelated tasks without
reading every `task.json`.

### Multi-node request recovery

- delivered requests use a delivery lease and can be redelivered if completion
  does not arrive;
- each new gateway tool invocation receives a fresh node request ID. The same
  pending request keeps that ID across delivery-lease redelivery, but a later
  identical invocation gets a new ID;
- non-TTY durable `exec_command` uses the node request ID as an idempotency
  key, so redelivery returns the existing task rather than starting the command
  twice;
- workers persist request journals. A completed result is replayed after link
  failure rather than re-executing the tool;
- a journal is written as `started` before tool execution. If the worker
  crashes after a non-idempotent side effect but before it can persist the
  result, restart returns an explicit `IndeterminateNodeToolOutcome` instead
  of blindly executing the write again. Read-only calls and idempotent durable
  commands may be replayed;
- global task IDs are stable for the same `(nodeId, localTaskId)`;
- the old-host `devspace-task get/cancel <taskId>` compatibility path now
  rewrites global task IDs to the owning worker's local task ID, so stale host
  schemas remain able to recover remote tasks.

An earlier attempt derived node request IDs from host turn/request identity and
tool input. Live Code Mode experiments disproved that design: several tool
calls can share the same host request identity. Different commands initially
collided, and adding an input hash still caused two intentional identical
`date +%s%N` invocations in one turn to return the same run/result. There is
no principled way to distinguish a transport retry from a real repeated call
when the host supplies no per-invocation identity. Content/turn-based
exactly-once deduplication was therefore removed. Live verification now shows
two identical remote invocations produce distinct timestamps and run IDs,
while the delivery-lease test retains the same node request ID for an actual
redelivery of one pending request.

### Learning safety

- explicit learning evidence must consist only of successful episodes;
- promotion revalidates that all evidence still exists and is successful;
- promotion never overwrites a different existing project skill;
- an identical skill left behind by a crash between file creation and database
  update is treated as an idempotent retry;
- the deterministic capability benchmark now verifies failed-evidence
  rejection rather than reporting a hard-coded
  `evidenceBindingVerified=false`. The current benchmark reports
  `evidenceBindingVerified=true`.

### Architecture governance

Current deterministic governance evidence is 6/6 cases with zero observed
false positives or false negatives in the fixture and roughly single-digit
millisecond mean engine time. `show_changes` calls architecture
`conformance()`, which refreshes the model from the current working tree
before validation, so dependency checks are not performed against a stale
observed graph.

The remaining boundary is deliberate but important: architecture conformance
is currently a mandatory review checkpoint, not a transactional filesystem
firewall. If a host skips `show_changes`, invalid working-tree edits are not
automatically rolled back. Static dependency inference also cannot represent
every dynamic/runtime relation.

### Placement and build provenance

Both current nodes advertise `/home/swy/Synrex` and
`/home/swy/ros2_ws`, so no-rule placement makes a fresh open ambiguous by
construction. The gateway configuration now prefers the gateway node for both
paths while retaining explicit worker override for GPU/simulation work.

The two `ros2_ws` copies are not equivalent: the gateway checkout was observed
at a newer revision than `swy1`. Placement therefore must not treat
same-looking paths as interchangeable replicas.

A further deployment inconsistency was found on `swy1`: the live service runs
`/home/swy/Synrex/dist/cli.js` and has compiled multi-node modules that are
absent from the local source tree. The runtime can work, but the node cannot
reproduce its running binary from that checkout. Candidate node registration
now reports Synrex version plus an actual runtime build fingerprint, and
`nodes list` exposes match/mismatch/unknown status. This detects binary drift
without assuming every worker keeps a source checkout.

There is not yet a first-class worker upgrade/data-distribution mechanism.
Direct SSH from the gateway to `swy1` was not available in the current
environment, and overwriting a dirty worker source tree would be unsafe.
Multi-node deployment/rolling upgrade therefore remains an open control-plane
work item.

Role-critical artifact comparison narrowed the current worker drift: the
worker execution path (`cli/server/config/tool-invoker/worker-client`,
durable-task modules, process/workspace/skill and local-agent modules) matched
the gateway build byte-for-byte at the time of inspection. The worker's
`local-node.js` provenance reporter was older and was hot-updated without
overwriting its dirty source checkout. After restart, node registration exposes
the worker checkout fingerprint separately; it differs from the gateway source
fingerprint, making the rebuild hazard explicit. The worker still lacks
`buildSource` because its copied artifact did not include a reproducible
`build-info.json`. A first-class artifact rollout must copy build metadata and
must not assume a dirty worker checkout is the source of its running binary.

### Provider/subagent health

One subagent attempt initially reported daemon startup failure. A later attempt
started the daemon successfully and then failed at the external Codex provider
with a retryable stream/network disconnect. Provider discovery currently
means the local executable/configuration exists, not that a complete provider
turn is reachable. Evaluation should report installed, daemon-ready,
provider-reachable, and turn-success as separate layers instead of attributing
all failures to Synrex.
