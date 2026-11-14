# Workflow/Workspace lifecycle P1–P4 (development implementation)

Historical status (2026-10-28): isolated source implementation, not deployed.
**2026-11-14 integration:** selected P1–P4 functionality is being reconciled
against `v0.3.0` in a separate candidate. Startup and periodic destructive GC
are deliberately **disabled**: default CLI is preview-only and requires
`--execute` for an explicit cleanup; the browser can only preview.
The actual tag and production manifest, not this document, prove deployment.

## P1 — Task ownership and recovery

- `coding_workflows.workspace_session_id` is an additive nullable column for backward compatibility.
- `workflow_open` saves the owning registered `workspaceId`; `workflow_open(workflowId)` without a workspaceId finds it in a new conversation and rechecks its live Git state without creating a new worktree.
- Legacy workflows without a registered ID still require reopening the original workspace and `workflow_status`.
- Within the same conversation, `open_workspace(mode=worktree)` reuses the same registered worktree for the same canonical source and base ref; separate conversations still isolate independent writes.
- Existing Workflow checkpoints remain separate from source-of-truth Git commits and task receipts.

## P2 — Lifecycle safety

- Lifecycle classification: active (unfinished workflow or live lease), protected (unknown owner/unknown state), idle (retention), reclaimable candidate, archived.
- `workflow_open(leaseAction=acquire|renew|release, workspaceId, leaseId?)` manages an unguessable 30-minute workspace lease without adding another host-facing MCP tool; a process crash does not leave an indefinite live lease.
- `pruneCompletedWorktrees` filters on known completed/cancelled workflows, expired retention and no active leases, then calls the **existing** conservative Git cleanup with `safeOnly=true`.
- A SQLite compare-and-set claim temporarily makes a candidate inaccessible to new Workspace sessions while Git safety checks and removal run. Skipped candidates become active again. A cross-process lifecycle lock serializes workflow status transitions, leases and GC.
- The historical automatic GC at startup and every six hours is **not adopted**.
  A read-only startup inspection and explicit peer-local CLI execution
  replace unattended directory deletion; unknown ownership is protected.
- The lifecycle marker intentionally fails closed if a process crashes mid-GC. Inspect `.worktree-lifecycle-lock` before manually clearing a stale marker.
- **2026-11-14 reconciliation:** the legacy CLI now defaults to read-only
  `prune` preview. `--safe` remains a compatibility alias for preview;
  only `--execute` opts into the newer completed-workflow and Git-safe
  cleanup contract. Low-level Git cleanup remains separate and unchanged.

## P3 — Console

- Owner-authenticated `GET /console/api/workspaces` returns bounded status and reasons.
- Per-workspace detail requests measure disk (`du`, 4s timeout) and local Linux cwd processes **on demand** using asynchronous IO; the rapid Core snapshot collector does not perform recursive scans.
- POST `/console/api/workspaces/gc` requires an authenticated same-origin
  request; `{ "execute": false }` is preview, and `execute:true` is rejected
  with HTTP 403. Filesystem cleanup is never granted by a browser session.

## P4 — Acceptance and limits

- Focused workflow/workspace/Git/Console tests and typecheck run in the isolated development tree.
- `scripts/benchmark-parallel-workspaces.ts` covers 1, 2, 4, 8 conversations, shared vs isolated file writes. The local benchmark records lost writes, p50/p95 and wall duration.
- Tests include reconnecting via workflow ID, simultaneous GC attempts, lease protection, stale access compare-and-set, dirty Git refusal and safe completed cleanup on a temporary Git repository.
- This benchmark does **not** measure ChatGPT UI reply streaming, model reasoning latency, network RTT, real multihost traffic or production p95. Those require authenticated end-to-end acceptance before shipping.

## Release handoff

Keep the pinned production release untouched until the other cleanup worktree's changes have been reconciled and the combined tree passes compatibility tests, UI QA, authenticated MCP verification and release rollback gates.
