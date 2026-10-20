# ADR: Event-first task completion, with bounded adaptive fallback

Status: accepted design direction, source-side incremental implementation;
MCP Events / official Tasks extension integration remains unimplemented.
Date: 2026-10-20.

## Problem, observed facts, and scope

GPT repeatedly calling status tools wastes model/tool turns and may delay
delivery. A stuck ChatGPT response is **not** proof that Synrex is stuck:
diagnostics separately identify tool start/finish, HTTP response completion,
transport closure, and model-host silence. A tool completing with HTTP 200
cannot force a ChatGPT model to generate another turn.

Current release includes task_get, compact semantic revisions, recommended
5/15/30/60-second host poll intervals, bounded task_wait, durable run IDs,
checkpoint recovery, and non-idempotent remote replay protection. Earlier
task_wait internally re-read task state every 500 ms for an 8/10-second call.
This incurred server I/O but did not produce new GPT tool calls.

## Decision: transport- and host-aware completion strategy

1. **Execution peer is the source of truth.** Detached runners persist status,
   completion, and output. Never tie a command's lifetime to an MCP socket,
   ChatGPT response, file watcher, or webhook callback.
2. **Event-first local wait.** Watch the containing directory of task.json
   for the runner's atomic rename; coalesce short bursts, re-read and verify
   the actual task state, and compare semantic revisions. A filesystem watch
   is an optimization, NOT durable event delivery or authoritative state.
3. **Bounded adaptive safety reads.** Without notifications, or after a
   lost event, start at approximately 300 ms and grow by 1.6-1.8x with jitter
   up to 2.5 seconds. Each model-facing task_wait remains bounded at 10
   seconds. Never extend the call beyond its host/transport budget.
4. **Legacy remote peer fallback.** Only if a remote peer advertises task_get
   but not task_wait, route task_wait to a bounded coordinator-side
   read-only wait via task_get; preserve global task identity and compact the
   receipt. Never retry exec_command, apply_patch, or other side effects.
5. **Feature-negotiated push, not an invented callback.** Investigate MCP
   Tasks extension (io.modelcontextprotocol/tasks) and
   notifications/tasks over subscriptions/listen when actual clients
   advertise and honor them. For ChatGPT Work/dots, separately consider
   OpenAI MCP Events (events/list, subscribe, unsubscribe, verified webhooks).
   Ordinary ChatGPT chat is not presumed to receive or act on such events.
6. **Other-host compatibility.** Expose stable task IDs, status, and an
   immediate task_get regardless of event support. Do not require a
   ChatGPT-specific webhook, Codex hook script, or protocol-version update
   for conventional coding.
7. **Completion is evidence, not inference.** Terminal state, tests,
   exit code and logged artifacts still need interpretation. A heartbeat
   is not progress. A file event is not completion. Never mistake HTTP 200
   for model continuation or retry an ambiguous write automatically.

## Host paths

| Host | Preferred completion | Fallback | Limitation |
| --- | --- | --- | --- |
| Ordinary ChatGPT MCP | Bounded tool wait + compact receipt | task_get with recommended backoff | Cannot force the model to resume after turn end |
| Work or dots with MCP Events support | Explicit user subscription to verified task-completed events | Bounded task wait | Requires authenticated subscriptions/webhook delivery and currently supported host capability |
| Generic MCP 2026 Tasks client | notifications/tasks on subscriptions/listen when negotiated | tasks/get suggested interval | Host must consume notifications and decide how to continue |
| Synrex remote peers | Local OS event or peer task status; negotiated read-only route | bounded task_get polling | Old peers may not implement task_wait |

MCP core protocol revision 2026-07-28 removes the old GET SSE
notifications path; subscriptions/listen uses a long-lived POST-response
stream. Do not implement an obsolete SSE GET as if it were portable.
MCP Events uses callback delivery and must not be confused with MCP Tasks
status notifications. Codex lifecycle hooks are likewise distinct: they
run trusted scripts where the host's execution runtime is installed, and
do not automatically grant ordinary browser ChatGPT model-continuation.

## Event safety if Work/dots integration is later approved

- Use principal-scoped subscriptions with explicit task/project filters;
  never broadcast another owner's task ID or logs.
- Verify webhook URLs with a signed, single-use challenge; require TLS,
  prevent localhost/private-network/redirect SSRF, validate signatures and
  expiration, and store subscriptions durably and encrypted as appropriate.
- Outbox with monotonic event ID, bounded retries/jitter, idempotent delivery,
  dedupe by subscription+event, and cancellation/unsubscribe cleanup.
- Default terminal events to notification/reporting. Running privileged or
  destructive follow-on work requires an authenticated, policy-authorized
  operation and must not be inferred solely from the event.
- Preserve zero impact on legacy OAuth clients, pinned releases, and normal
  coding when no event-enabled host is connected.

## Acceptance and evaluation

Measure three distinct quantities: (A) task status disk reads per task,
(B) model-facing tool calls and context tokens per completed coding task,
(C) true human-visible stall/failure rates with correlated HTTP and
tool-finish evidence. Compare fixed 500-ms local reads, adaptive-only
waiting, file-event-first waiting, and host push *where available*.
Include silent jobs, frequent-output jobs, missed file events, orphaned
runners, task cancellation, server restart and gateway disconnect.

Do not infer a percent improvement from synthetic mocks or one hour of
partial diagnostics. End-to-end task quality and side-effect safety are
the release gates, not simply fewer polling requests.

Useful primary references:
- MCP 2026-07-28 Streamable HTTP and Tasks extension.
- OpenAI Plugins: MCP Events (Work/dots callback subscription only).
- OpenAI Plugins: plugin lifecycle hooks (manual/trusted local runtime).
