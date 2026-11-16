import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { assessGoal } from "./goal-continuity.js";
import { verificationCommand, withWorkflowReceipt } from "./goal-continuity-runtime.js";

test("goal is not satisfied by a successful operation or self-reported checks", () => {
  const state = mkdtempSync(join(tmpdir(), "synrex-goal-"));
  const root = join(state, "work");
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "Fix", goal: "Fix tested feature", acceptanceCriteria: ["test passes"],
      constraints: [], workspaceId: "ws_goal12345",
    });
    const initial = assessGoal(wf, store.evidence(wf.workflowId, root));
    assert.equal(initial.status, "unknown");
    const operation = store.observe(root, wf.workflowId, {
      eventKey: "run:echo", kind: "command", status: "completed",
      runId: "run_echo", exitCode: 0,
    });
    assert.equal(assessGoal(wf, store.evidence(wf.workflowId, root)).status, "unknown");
    assert.throws(() => store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "completed",
      checkpoint: { ...wf.checkpoint, checks: ["everything passed"],
        criterionEvidence: [{ criterion: 0, eventId: operation.eventId }] },
    }), /Goal Finish Gate/);
    store.bind(wf.workflowId, root, "ws_goal12345", "conversation-1");
    assert.equal(store.selected(root, "ws_goal12345", "conversation-1")?.workflowId, wf.workflowId);
    assert.equal(store.selected(root, "ws_goal12345", "conversation-2"), undefined);
    assert.throws(() => store.selected(root, "ws_different", undefined, wf.workflowId), /another workspace/);
    const receipt = withWorkflowReceipt({
      stateDir: state, workspaceRoot: root, workspaceId: "ws_goal12345",
      conversationScope: "conversation-1",
      observation: {
        eventKey: "run:check", kind: "verification", status: "completed",
        runId: "run_check", exitCode: 0,
      },
    }, { content: [{ type: "text", text: "exit=0" }], structuredContent: { exitCode: 0 } });
    const fields = receipt.structuredContent as Record<string, unknown>;
    assert.equal((fields.operation as { status: string }).status, "completed");
    assert.equal((fields.continuity as { status: string }).status, "unknown");
    const evidenceRef = fields.evidenceRef as string;
    const done = store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "completed",
      checkpoint: { ...wf.checkpoint, checks: ["test confirmed"],
        criterionEvidence: [{ criterion: 0, eventId: evidenceRef }] },
    });
    assert.equal(done.status, "completed");
    assert.equal(assessGoal(done, store.evidence(wf.workflowId, root)).status, "satisfied");
  } finally {
    store.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test("verification command recognition rejects shell control operators", () => {
  assert.equal(verificationCommand("pnpm test"), true);
  assert.equal(verificationCommand("pnpm typecheck"), true);
  assert.equal(verificationCommand("pnpm exec tsx --test src/example.test.ts"), true);
  assert.equal(verificationCommand("pnpm test; echo fine"), false);
  assert.equal(verificationCommand("echo pass"), false);
});

test("an unfinished run, a failed test, and a self-reported pass never satisfy acceptance", () => {
  const state = mkdtempSync(join(tmpdir(), "synrex-pending-"));
  const root = join(state, "project");
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "Repair", goal: "Make build pass", acceptanceCriteria: ["build passes"],
      constraints: [], workspaceId: "ws_pending12",
    });
    const pending = store.observe(root, wf.workflowId, {
      eventKey: "run:long", kind: "verification", status: "working",
      runId: "run_long", taskId: "task_12345678",
    });
    assert.equal(assessGoal(wf, store.evidence(wf.workflowId, root)).status, "in_progress");
    assert.throws(() => store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "completed",
      checkpoint: { ...wf.checkpoint, checks: ["claimed passed"],
        criterionEvidence: [{ criterion: 0, eventId: pending.eventId }] },
    }), /Goal Finish Gate/);
    store.observe(root, wf.workflowId, {
      eventKey: "run:long", kind: "verification", status: "failed",
      runId: "run_long", taskId: "task_12345678", exitCode: 1,
    });
    assert.equal(assessGoal(wf, store.evidence(wf.workflowId, root)).status, "unknown");
    assert.throws(() => store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "completed",
      checkpoint: { ...wf.checkpoint, checks: ["claimed passed"],
        criterionEvidence: [{ criterion: 0, eventId: pending.eventId }] },
    }), /Goal Finish Gate/);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("two conversations can select different workflows without cross-binding", () => {
  const state = mkdtempSync(join(tmpdir(), "synrex-scope-"));
  const root = join(state, "project");
  const store = new CodingWorkflowStore(state);
  try {
    const a = store.create(root, {
      title: "A", goal: "Fix A", acceptanceCriteria: ["A passes"],
      constraints: [], workspaceId: "ws_scope123",
    });
    const b = store.create(root, {
      title: "B", goal: "Fix B", acceptanceCriteria: ["B passes"],
      constraints: [], workspaceId: "ws_scope123",
    });
    store.bind(a.workflowId, root, "ws_scope123", "conversation-A");
    store.bind(b.workflowId, root, "ws_scope123", "conversation-B");
    assert.equal(store.selected(root, "ws_scope123", "conversation-A")?.workflowId, a.workflowId);
    assert.equal(store.selected(root, "ws_scope123", "conversation-B")?.workflowId, b.workflowId);
    assert.equal(store.selected(root, "ws_scope123", "conversation-C"), undefined);
    assert.equal(store.selected(root, "ws_scope123", undefined, b.workflowId)?.workflowId, b.workflowId);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("unselected conversations get unchanged minimal tool result", () => {
  const state = mkdtempSync(join(tmpdir(), "synrex-unselected-"));
  try {
    const response = { content: [{ type: "text", text: "ok" }], structuredContent: { result: "ok" } };
    const actual = withWorkflowReceipt({
      stateDir: state, workspaceRoot: state, workspaceId: "ws_some123",
    }, response);
    assert.strictEqual(actual, response);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
