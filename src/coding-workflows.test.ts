import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingWorkflowStore } from "./coding-workflows.js";

test("coding workflow survives store re-open, records evidence and rejects stale writers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workflow-"));
  let store: CodingWorkflowStore | undefined;
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  const state = join(root, "state");
  const first = new CodingWorkflowStore(state);
  const created = first.create(project, {
    title: "Long code change",
    goal: "Implement tested recovery",
    acceptanceCriteria: ["The recovery test passes"],
    constraints: ["Do not modify production"],
    requestKey: "retry-safe-create-1",
  });
  assert.equal(created.revision, 0);
  assert.equal(first.create(project, {
    title: "Long code change", goal: "Implement tested recovery",
    acceptanceCriteria: ["The recovery test passes"],
    constraints: ["Do not modify production"], requestKey: "retry-safe-create-1",
  }).workflowId, created.workflowId);
  assert.throws(() => first.create(project, {
    title: "Different", goal: "Different work",
    acceptanceCriteria: ["The recovery test passes"],
    constraints: ["Do not modify production"], requestKey: "retry-safe-create-1",
  }), /requestKey reused/);
  assert.equal(first.list(project).length, 1);
  first.close();

  store = new CodingWorkflowStore(state);
  assert.equal(store.getRequired(created.workflowId, project).goal, "Implement tested recovery");
  assert.throws(() => store.getRequired(created.workflowId, join(root, "other")), /not found/);
  const resumed = store.checkpoint(project, {
    workflowId: created.workflowId,
    expectedRevision: 0,
    status: "blocked",
    checkpoint: {
      summary: "Tests run but build failed",
      phase: "verification",
      completedSteps: ["Updated source"],
      nextSteps: ["Fix build"],
      blockers: ["Typecheck failure"],
      checks: ["pnpm typecheck: exit 2"],
      taskIds: ["task_0123456789abcdef"],
    },
  });
  assert.equal(resumed.revision, 1);
  assert.equal(store.checkpoint(project, {
    workflowId: created.workflowId, expectedRevision: 0,
    status: "blocked", checkpoint: resumed.checkpoint,
  }).revision, 1, "an identical checkpoint replay must not create another event");
  assert.equal(resumed.status, "blocked");
  assert.throws(() => store.checkpoint(project, {
    workflowId: created.workflowId,
    expectedRevision: 0,
    status: "completed",
    checkpoint: resumed.checkpoint,
  }), /revision conflict/);
  assert.equal(store.history(created.workflowId, project).length, 1);
  const done = store.checkpoint(project, {
    workflowId: created.workflowId,
    expectedRevision: 1,
    status: "completed",
    checkpoint: { ...resumed.checkpoint, summary: "Verified", nextSteps: [], blockers: [], taskIds: [] },
  });
  assert.equal(done.revision, 2);
  assert.equal(store.list(project).length, 0);
  assert.equal(store.list(project, { includeCompleted: true }).length, 1);
  assert.deepEqual(store.history(created.workflowId, project).map((entry) => entry.revision), [2, 1]);
  assert.throws(() => store.checkpoint(project, {
    workflowId: created.workflowId,
    expectedRevision: 2,
    status: "active",
    checkpoint: resumed.checkpoint,
  }), /cannot be changed/);
  const permissions = (await stat(join(state, "coding-workflows.sqlite"))).mode & 0o777;
  if (process.platform !== "win32") assert.equal(permissions, 0o600);
});
