# ADR: Event-first task completion, with bounded adaptive fallback

Status: accepted direction, scoped to ordinary ChatGPT conversations. Local
event-first task waiting is implemented; automatic host continuation remains
unproven. Work/dots integration is outside the product's primary scope.
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
5. **Ordinary-conversation bridge, not an invented callback.** Investigate
   the ChatGPT MCP App widget bridge as an optional *in-conversation*
   mechanism: `window.openai.callTool` for reading task status and
   `window.openai.sendFollowUpMessage` for asking the host to submit a new
   turn. Test this with explicit user clicks first; investigate fully
   automatic forwarding only in a disposable proof of concept with a visible
   opt-in and conservative rate limits. Do not assume a widget stays alive
   in the background or guarantees tools are attached to a follow-up turn.
   Generic MCP Tasks notifications may be used only when an ordinary-chat
   client advertises and actually consumes them. **Do not build Work/dots
   MCP Events or a background model service into the Synrex core.**
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
| Ordinary ChatGPT MCP, no widget | Bounded task_wait + compact receipt | task_get with recommended backoff | Cannot force model continuation after a turn ends |
| Ordinary ChatGPT MCP App widget (optional) | Widget can read task status; explicit Resume control can request follow-up message via host bridge | Model-visible task IDs and manual follow-up | Background auto-follow-up and tool continuity are unverified |
| Generic MCP Tasks-aware host | notifications/tasks on subscriptions/listen when negotiated | tasks/get suggested interval | Generic capability does not imply ordinary ChatGPT supports notifications |
| Synrex remote peers | Local OS event or peer task status; negotiated read-only route | bounded task_get polling | Old peers may not implement task_wait |

## Six-tool host compatibility and context budget (2026-10-20 follow-up)

The original ChatGPT connector may still expose only six tools even when the
deployed server advertises `task_wait`. `exec_command` therefore accepts the
exact internal command `devspace-task wait <taskId>` and invokes the same
bounded, read-only event-first waiter, **without starting a shell command**.
The immediate `devspace-task get` behavior is unchanged. On a remote peer,
the coordinator verifies the task-owner binding and routes the compatibility
wait to advertised `task_wait` v1 or bounded `task_get` v1, never to an old
peer's shell. Unadvertised/incompatible peer contracts fail closed. This
preserves the six-tool interface and requires no additional GPT tool schema.

The agent entrypoint now contains only critical authority/execution and
release instructions, linking the complete unchanged engineering playbook
for protected/cross-cutting work. Default AGENTS.md payload went from 14,431
to 4,790 bytes (67% fewer bytes), while the detailed guidance remains in
`docs/SYNREX_AGENT_PLAYBOOK.md`. This is an input/context reduction, **not**
proof of an equivalent percentage reduction in end-to-end GPT task time.
The host's model thinking and external MCP round-trip overhead still require
real-client measurements.

MCP core protocol revision 2026-07-28 removes the old GET SSE
notifications path; subscriptions/listen uses a long-lived POST-response
stream. Do not implement an obsolete SSE GET as if it were portable.
OpenAI MCP Events currently applies to Work/dots, not the ordinary
conversation target of Synrex, and is **not a planned core integration**.
Codex lifecycle hooks are likewise distinct from normal ChatGPT chat.
An HTTP domain, WebSocket, SSE, reverse proxy, or Cloudflare worker can
transport events, but none confers authority to insert new host messages.

## Optional ordinary-chat widget feasibility gate

The public ChatGPT Plugin UI reference documents
`window.openai.sendFollowUpMessage({prompt})` and `window.openai.callTool`.
These are an actual bridge exposed to a *rendered* MCP App component, not a
general-purpose remote push API. Developer reports describe follow-up
requests that cause duplicate widgets/tool calls or lose the connector
toolset. These are reasons to test, not guarantees of failure on every host.

Use a disposable read-only dummy task before touching long-running
production operations: (1) verify the widget bridge exists; (2) render
completion from authenticated project-scoped status; (3) press an explicit
Resume button; (4) verify the next GPT turn receives a non-replayed task
receipt and can call Synrex tools; (5) test widget suspension, tab switches,
mobile vs browser, reload, and two simultaneous tasks. Only consider an
optional auto-follow-up mode if the host reliably accepts a single bounded
follow-up under explicit user opt-in; prohibit repeated automatic prompts,
cross-project leakage and destructive follow-on actions.

## Ordinary-chat UI bridge safety

- The widget must be optional: pure conversational tool calls work without it.
- Enforce authenticated task/project ownership on every status request.
- Use stable task ID and terminal revision to dedupe follow-up prompts.
- Make automated resume opt-in, if ever supported; never retry mutating
  commands automatically from a widget lifecycle event.
- A background task may continue without a chat; a widget must not claim it
  can keep the model running independently of the ChatGPT host.
- Prefer a local completion badge and explicit user Resume control when
  a follow-up cannot be reliably initiated automatically.

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
- OpenAI Plugins: UI reference for window.openai.sendFollowUpMessage and callTool.
- OpenAI Plugins: MCP Events (Work/dots only; excluded from this product's core).
