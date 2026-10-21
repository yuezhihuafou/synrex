# ChatGPT conversation correlation and stalled-work recovery

## What the server can observe

Synrex receives MCP tool calls, not the ChatGPT page state. When ChatGPT sends
`_meta["openai/session"]`, tool events include a stable `conv_<hash>` identifier.
The raw session identifier is never written to diagnostic traces. Request IDs,
call IDs, workspace IDs, run IDs and task IDs remain independently traceable.

**ChatGPT does not reliably send conversation titles to MCP.** An actual title
may be supplied explicitly via `open_workspace.conversationTitle` (in clients
whose tool schemas have refreshed), or by a host adapter that supplies
`_meta["openai/conversation_title"]`. A `conversation_labeled` diagnostic
event records that opt-in title. Missing titles stay missing; neither
timestamps nor workspace paths are treated as conversation titles.

For local, private diagnostics:

```sh
synrex diagnose --minutes 120
synrex diagnose --minutes 1440 --title 'Synrex问题分析'
synrex diagnose --minutes 1440 --conversation conv_<32-lowercase-hex>
```

The trace retains two rotating 1 MiB files and has a bounded time window.
Historical titles absent from retained host metadata cannot be recovered.

## Recover without replaying side effects

1. If a ChatGPT turn appears stuck, record its visible conversation title and
   last task/workspace ID if available. Do not cancel a running command solely
   because the ChatGPT UI stopped updating.
2. Open another conversation and call `open_workspace` for the same checkout.
   `activeTasks` lists live durable command handles; `pendingTasks` lists
   unacknowledged *terminal receipts*, not live commands. The latter may include
   old unrelated jobs and must not be interpreted as work still running.
3. For the relevant handle use `task_get` or `exec_command` with
   `devspace-task get <taskId>`. Read the saved `runId` log, exit status and
   actual code/test evidence before deciding whether to resume work.
4. Continue unfinished dependent steps from a saved coding workflow checkpoint
   when one exists. Never automatically replay an uncertain file write or
   deployment. A terminal shell process is **not** proof of task acceptance.
5. A closed or stalled ChatGPT turn **cannot be awakened** by this MCP server.
   Resume through a new user message/chat after collecting the task receipt.

During a release switch the HTTP listener first stops accepting new requests;
accepted requests drain (at most the configured forced-close interval) before
shared SQLite and router resources are disposed. Tool output may still be lost
at the host transport boundary; durable receipts must be checked afterwards.
