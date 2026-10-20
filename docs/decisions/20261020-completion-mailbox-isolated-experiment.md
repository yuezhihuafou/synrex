# ADR: Completion Mailbox and final dependency barrier (isolated experiment)

Status: **integrated into a swy1 production release candidate**. This ADR
records the original isolated experiment from commit `3415410` (based on
`1c2e181`) and its verified behavior. Source integration and QA alone are
not evidence of production activation: confirm the immutable pinned
`devspace.service` ExecStart, live OAuth/MCP and rollback receipt.
Production retains its existing OAuth issuer and SQLite; test state is
never copied into owner state.

## Problem and decision

An ordinary ChatGPT conversation might start slow task A, continue useful,
independent tasks B/C/D, and still be forced to repeatedly poll A even though
the client would otherwise receive ordinary MCP responses. Optimize the
common case by using those **already-expected tool responses** as a mailbox
for A's completion, without Webhook permission or another model.

The last dependent task is an explicit exception: once independent work is
exhausted, GPT should use a bounded final wait rather than declare completion
or invent unrelated tasks. The final wait is **not** a hook into ChatGPT
message completion. The host can always stop the model; Synrex must preserve
the running task and truthful pending status.

## Mechanism

1. When `exec_command` returns a *running* durable `taskId`, store an
   owner-scoped registry row in a separate 0600 SQLite database under the
   existing configured Synrex state directory. No shell commands or output
   text are stored in the mailbox.
2. An ordinary follow-on tool call with the same `workspaceId` and the same
   hashed `openai/session` (when provided by the host) checks only registered
   tasks. The actual local durable task state is verified using its existing
   owner-checked `get(..., acknowledge:false)` operation. The lookup does
   not launch or replay a command.
3. On a terminal state, append **one separate, short MCP content text block**
   (at most two notices per response), including a task ID, status, revision,
   exit code if known, and run-log handle. Preserve the original
   `structuredContent`, original text and error state verbatim; never insert
   arbitrary task stdout or error messages as model instructions.
4. A notification is marked presented, but cannot be assumed delivered to the
   model if the HTTP transport closes. For unreconciled events, allow a limited
   retry after two minutes (maximum three presentations). A subsequent direct
   terminal `task_get`, `task_wait`, or compatible `devspace-task get/final`
   acknowledges its event. The mailbox does not claim exactly-once delivery.
5. Registry entries expire after 48 hours and are scoped by workspace ID,
   not by a guessed filesystem path. If `openai/session` is absent, an
   explicitly single-owner **workspace-only fallback** is used; do not
   misrepresent this as cross-conversation isolation. Verify whether the real
   GPT client supplies the session key before shipping to other users.
6. The source peer currently inspects local durable tasks. A remote peer can
   mail task events alongside later tools routed to that peer, but **a gateway
   completion cannot yet be pushed automatically into an unrelated swy1 tool
   response**. Add a peer event channel only after real gateway QA.

## Final task barrier

After all useful independent work, request `task_wait(final=true)` or, in
cached six-tool clients, `exec_command` with `devspace-task final <taskId>`.
Both keep the existing **10-second bounded MCP wait** and use local
event-first file notifications with bounded progressive safety checks. The
returned `finalBarrier` is an advisory state:

- Before one minute of job age: recommended next-check delay doubles
  approximately every 15 seconds (2, 4, 8, 16 seconds), capped at 60 seconds.
  Run-log IDs and the durable task handle remain stable.
- After one minute, if still pending: the server **grabs** compact run-log
  metadata read-only; return output counts/activity and a prompt to inspect
  `devspace-log tail/grep`, verify process/peer state, or checkpoint the
  unresolved task. A still-running job is not automatically classified failed
  merely because a minute elapsed.
- If the task completes or fails: return the terminal status. The GPT host
  must inspect the result and actual acceptance tests; a zero process exit
  does not prove task-level success.

No automatic command replay, destructive cancellation, hidden Gemini agent,
unbounded SSE connection, or invented ChatGPT callback is part of this flow.
The model cannot truly pause itself for the recommended gaps unless its host
supports waiting; the cadence is **advisory**, and a brief bounded tool wait
remains available. If the host turn ends, checkpoint the pending handle and
reconcile in the next conversation.

## Acceptance tests

- A runs for several seconds. B (in another session) must not receive a
  completion, while C (in A's session and workspace) receives one small text
  block on its ordinary `read` response. No duplicate on immediate D.
- Reopen the mailbox database and verify pending events survive a service
  restart, scoped correctly and with bounded delayed redelivery.
- Confirm a direct task inspection acknowledges delivery and avoids
  repeated Mailbox messages.
- Verify legacy six-tool final wait via `devspace-task final`, a terminal
  receipt and a bounded escalating status for a slow job.
- Compare GPT task success/context/tool-call count, not simply internal disk
  reads. Test an actual authenticated HTTP MCP client and malformed or
  interrupted connections before promotion.

The mailbox is a local execution status signal. It is not a substitute for
the model deciding dependencies, writing code, or verifying a research/demo
objective, and it cannot inject a message into an idle ChatGPT conversation.
