# Diagnosing apparent ChatGPT / Synrex stalls

Synrex tool execution, MCP transport, ChatGPT reasoning, and durable shell runners
are different lifecycles. A stalled ChatGPT turn does not by itself prove that
the server or a command is hung.

## Correlating an incident

The server records `tool_execution_started` and `tool_execution_finished`
with the same `callId`, `tool`, optional `workspaceId`, and HTTP `requestId`.
After 20 seconds without a handler result, it records
`tool_execution_stalled`; additional warnings occur once per minute. The
watchdog is observational: **it does not abort a mutating operation**.

The HTTP middleware separately emits `http_request` when a response finishes,
or `mcp_response_closed_early` if an MCP response closes prematurely. Review
these events in the swy1 user service journal for the incident window.

Interpretation:

- **Started, no finished:** the Synrex handler may still be running, stuck, or
  waiting on a downstream dependency. Check the same request ID and any
  durable task handle before retrying a write.
- **Finished, no HTTP completion:** investigate MCP adapter/transport and any
  early-close event; do not automatically repeat a mutating call.
- **Finished and HTTP 200:** the server finished its portion; investigate the
  ChatGPT client/host/model continuation if the user still sees a stall.
- **Long command returned a task ID:** the MCP call has already finished; use
  `task_get` (or `devspace-task get` compatibility dispatch) and saved run logs
  to determine whether the detached command is still running.
- **No tool start event:** the pause happened before the server's tool handler,
  or the tool never reached this server. The Synrex journal alone cannot identify
  which host component blocked it.

Tool execution logs record only identifiers and duration; not tool inputs,
shell commands, credentials, or file content. Do not infer model-loop liveness
from server-side heartbeats. The ChatGPT model cannot keep reasoning after its
conversation ends solely because a Synrex command persists.

## Recovery

For long coding sessions, use the persistent `workflow_*` checkpoint API and
capture outstanding durable task IDs before the conversation ends. In a new
conversation, reopen the same workspace, inspect Git and saved task logs, and
resume from the last validated checkpoint. If ChatGPT is exposing an older MCP
tool list than the running Synrex release, refresh the host tool connection or
start a new conversation; the server cannot force an already-open host turn
to acquire a newer schema.

Avoid automatic replay of `apply_patch`, Git write operations, or commands
without checking whether the prior operation completed. No source-level
watchdog can guarantee zero failures in the model host or external network.

Workflow creation accepts a stable request key, and a repeated identical
checkpoint does not create another revision. This does not make arbitrary
shell commands, Git writes or code patches safe to blindly replay.

To verify packaged release semantics, run
`pnpm exec tsx scripts/probe-reliable-release.ts <release-directory>`.
This uses a disposable private config and proves a non-interactive durable
command continues across a real service process restart. Always run against
an already-built pinned candidate, not against the production state directory.

## Minimal persistent evidence on swy1

Synrex also keeps a separate, small structured trace in
`<stateDir>/diagnostics/recent.jsonl` and `recent.jsonl.1`. Each file is at
most 1 MiB (approximately 2 MiB total). They are owner-only (0600) under an
owner-only directory (0700), and roll automatically without a log service.
This supplements, rather than duplicates, systemd journal and the persistent
command run logs.

From the pinned release on swy1, query:

```
node /home/swy/services/devspace/releases/20261020-rev-console-ui0-v1/dist/cli.js diagnose --minutes 30
```

It returns recent correlated `requestId`, `callId`, tool, optional `taskId`
and `runId`, start/end times, HTTP status and bounded duration. The output
classifies where each request was last observed. Diagnostics never store
tool inputs, command text, patch contents, HTTP headers, bearer credentials,
IP addresses, or raw error messages. If the model never sends a tool call,
there is no Synrex request trace to correlate: the last successful HTTP
completion establishes only that Synrex finished, not why ChatGPT stopped.

No event subscription or Work integration is required for this logging path.
