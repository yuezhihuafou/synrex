# GPT-led persistent coding workflows (P0–P2)

The **ChatGPT conversation remains the reasoning host**. Synrex owns executable
tools, durable processes, and persistent progress. This does not invoke Codex
CLI or an OpenAI API key, and it cannot initiate another ChatGPT turn after the
host conversation stops. Long-running **shell commands**, not model decisions,
may continue unattended.

## Model-facing API

All operations require a live `workspaceId` from `open_workspace` and are
scoped to that workspace's canonical path **on its execution node**.

1. `workflow_open(workspaceId, goal, acceptanceCriteria, title?, constraints?)`
   creates a workflow with a random `wf_` ID and revision 0. Opening with
   `workflow_open(workspaceId, workflowId)` resumes an existing workflow without
   modifying its revision.
   Supply a stable `requestKey` to make a repeated creation after a lost MCP
   response return the original workflow instead of producing a duplicate.
2. `workflow_checkpoint(workspaceId, workflowId, expectedRevision, status,
   phase, summary, completedSteps, nextSteps, blockers, checks, taskIds)`
   saves a full, accumulated snapshot, the local Git HEAD and porcelain status
   when available, and an immutable event. A stale revision is rejected. The
   `checks` field records **self-reported evidence**, not an automated test
   verdict. Set `status=completed` only when no unfinished work or unverified
   task IDs remain. Terminal workflows cannot be edited.
   Replaying an identical checkpoint and expected revision returns its existing
   committed revision; different stale checkpoints are rejected.
3. `workflow_status(workspaceId, workflowId?)` lists ongoing workflows or
   returns a selected workflow plus its last ten checkpoint events. Use
   `includeCompleted=true` to include historical terminal workflows in a list.

`open_workspace` also exposes a small `resumableWorkflows` summary. Workflow
identity is based on physical workspace path, **not** the transient workspace
session ID or GPT conversation identity. Thus reopening the same checkout in
another conversation reveals the unfinished workflow. Isolated worktrees are
separate workspaces by design. Workers persist their own workflow state rather
than centralizing Git, shell authority or robot control.

## Compatibility with older ChatGPT tool snapshots

If an existing ChatGPT conversation still exposes only six Synrex tools, use
`exec_command` to invoke the same workflow store through
`node bin/devspace.js workflow list` or
`node bin/devspace.js workflow show <wf_id>` in the corresponding checkout.
The CLI also supports `create` and `checkpoint` with validated JSON on stdin,
plus an explicit `--workspace <path>` option. It must use the **same**
`DEVSPACE_CONFIG_DIR` as the live service; otherwise it may open a different
state directory. This is a compatibility path, not another persistent store.

## Recommended GPT workflow

- For a substantial request, open or resume a workflow and read its goal,
  acceptance criteria, constraints, and last checkpoint.
- Inspect live Git state and relevant files; don't trust an old GPT summary
  as proof of current behavior. Then inspect, edit, test, diagnose and retry in
  the **same available conversation turn** until the task is verified or has a
  concrete blocker.
- Save checkpoints after verified milestones and before ending unfinished
  work. Record commands/outcomes, actual changed files or summary, relevant
  durable `taskId` handles and precise next steps; mark failures honestly.
- On resume, inspect task handles with `task_get` (or
  `exec_command: devspace-task get <taskId>` if the host's tool snapshot is old)
  and retrieve their actual logs before making dependent decisions.
- Workflow checkpoints are not shell process supervision, a substitute for Git
  commits, proof of test success, or a source of new reasoning when GPT is idle.

## Durability and deployment

Data is stored under the node's existing `stateDir` as
`coding-workflows.sqlite`, private mode `0600`, SQLite WAL and atomic
transactions. It is independent of `devspace.sqlite` so new workflow records
do **not** bump the OAuth/directory DB migration version or prevent rolling back
to the previous production binary. The owner-state backup script snapshots the
workflow SQLite file with the SQLite backup API when it exists. It is safe to
introduce the file on upgrade and leave it untouched on rollback.

For safe release from a dirty development checkout, build a pinned immutable
candidate, probe its tool surface and workflow behavior against **isolated**
state, capture production rollback state, and switch the owner release using
the tested owner cutover procedure. Never run `pnpm deploy:live` against the
pinned production release or overwrite the authoritative OAuth database.

The additional isolated release QA is:

```
pnpm exec tsx scripts/probe-reliable-release.ts <pinned-release-directory>
```

It creates disposable loopback OAuth credentials and state, tests real
authenticated MCP creation and checkpoint replay, starts a durable command,
restarts the candidate server, retrieves the command result and finishes the
original workflow using the recovered revision. It does not prove that an
already-open ChatGPT host has refreshed its tool schema, or that the public
service has passed a separate authenticated real-client test.
