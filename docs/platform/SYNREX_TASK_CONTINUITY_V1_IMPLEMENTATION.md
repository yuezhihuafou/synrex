# Synrex Task Continuity V1 implementation

## Scope

The reasoning Host remains ordinary ChatGPT. This feature neither creates a
second Agent loop nor runs Codex, API models, or an unattended ChatGPT wake-up.
It is a small, optional continuity contract around existing CodingWorkflowStore,
durable command receipts, tool responses, and the existing MCP App resource.

## State contract

- **Operation:** execution of a single patch or process, independently observed.
- **Goal:** derived from explicit acceptance-criterion references to successful,
  observed verification commands, plus pending work and blockers.
- **Workflow:** existing SQLite lifecycle with revision-checked checkpoints.

The derived Goal state is one of `unknown`, `in_progress`, `blocked`, or
`satisfied`. A command exit 0 is not goal completion. A model-supplied
`checks` note is not independent verification. A passing command only proves
the observed command exited successfully; it cannot establish the semantic
relevance of the command to a criterion. Users must inspect claims where that
connection cannot be verified mechanically.

## Binding and recovery

An explicit `workflow_open` or resume binds a workflow to a SHA-256 digest of
the Host-supplied `openai/session` scope, scoped to the matching workspace
session, for 12 hours; raw host session identifiers are never stored.
When Host scope is absent, callers must pass `workflowId` on tools to associate
results. Unselected tools keep their original lightweight output; no newest
workflow is inferred. Historical workflows without a workspace-session identity
can only be used with their original registered workspace.

Execution events are appended/upserted into `coding-workflow-evidence` in the
existing independent coding workflow SQLite database. Command exit, verification,
patch application, task ID, and run ID are recorded without copying shell
contents or sensitive output into the index. Unresolved tasks are never counted
as successful verification. Terminal task status is updated when inspected
through `task_get` or `task_wait`.

`workflow_checkpoint` accepts optional `criterionEvidence` references of the
form `{criterion, eventId}`; old checkpoints remain readable. Completion
requires passing observed verification evidence for each criterion and no
remaining steps, blockers, or unresolved tasks. Ordinary one-step coding tools
do not require workflows.

## MCP App

`workflow_open`, `workflow_status`, and `workflow_checkpoint` reuse the
existing `ui://devspace/workspace-app.html` resource when UI is enabled.
The compact workflow card provides status, remaining conditions, a **Continue**
user action, and manual-copy fallback. It first uses the standard
`App.sendMessage` bridge, then optional ChatGPT follow-up messaging. Host
support must be verified in a real user session; submission of a message does
not prove the model will run. No message is sent without a click.

## QA / release gates

1. Targeted workflow, goal, UI decoding, and process tests.
2. Typecheck and frontend/backend builds.
3. Integration test with a disposable MCP/OAuth owner and relevant UI resource.
4. Real ChatGPT host-side click/resume test when supported by the host.
5. Before live promotion, compare current production source SHA with canonical
   `origin/main`; require a clean, built, signed/verifiable immutable candidate,
   state backup, release lock, and rollback verification.

Inability to validate the actual host-side follow-up must be reported as
**unverified**, not silently treated as success.
