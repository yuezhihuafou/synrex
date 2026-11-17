import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingWorkflowStore } from "./coding-workflows.js";
import Database from "better-sqlite3";
import { assessGoal } from "./goal-continuity.js";
import { verificationScope, withWorkflowReceipt } from "./goal-continuity-runtime.js";

test("verification scope respects the actual command working directory", () => {
  const scope = verificationScope("pnpm exec tsx --test tests/sub.test.ts", "packages/demo");
  assert.ok(scope.includes("packages/demo/tests/sub.test.ts"));
  assert.ok(scope.includes("packages/demo/tests/sub.ts"));
  assert.ok(scope.includes("packages/demo/package.json"));
  assert.deepEqual(verificationScope("pnpm test", "packages/demo"), []);
});

function repository(): { state: string; root: string } {
  const state = mkdtempSync(join(tmpdir(), "synrex-cont-v11-"));
  const root = join(state, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "src", "helper.ts"), "export const helper = 1;\n");
  writeFileSync(join(root, "src", "feature.ts"), "import { helper } from './helper.js';\nexport const feature = helper;\n");
  writeFileSync(join(root, "src", "feature.test.ts"), "// test fixture\n");
  writeFileSync(join(root, "README.md"), "unrelated\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
  return { root, state };
}

test("Goal Gate requires one relevant, fresh observation per criterion", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "fix", goal: "fix test and lint", constraints: [],
      acceptanceCriteria: ["feature test passes", "lint passes"],
    });
    const command = "pnpm exec tsx --test src/feature.test.ts";
    const testEvidence = store.observe(root, wf.workflowId, {
      eventKey: "test", kind: "verification", status: "completed", exitCode: 0,
      command, verificationScope: verificationScope(command), source: "exec_command",
    });
    const claims = [{ criterion: 0, eventId: testEvidence.eventId },
      { criterion: 1, eventId: testEvidence.eventId }];
    const pending = { ...wf, checkpoint: { ...wf.checkpoint, criterionEvidence: claims } };
    assert.deepEqual(assessGoal(pending, store.evidence(wf.workflowId, root, claims.map(c => c.eventId))).verifiedCriteria, [0]);
    assert.throws(() => store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "completed",
      checkpoint: { ...pending.checkpoint, checks: ["claimed pass"] },
    }), /Goal Finish Gate/);
    const lintEvidence = store.observe(root, wf.workflowId, {
      eventKey: "lint", kind: "verification", status: "completed", exitCode: 0,
      command: "pnpm lint", verificationScope: [], source: "exec_command",
    });
    const complete = { ...wf, checkpoint: { ...wf.checkpoint, criterionEvidence: [
      { criterion: 0, eventId: testEvidence.eventId }, { criterion: 1, eventId: lintEvidence.eventId },
    ] } };
    const proofIds = complete.checkpoint.criterionEvidence.map(c => c.eventId);
    assert.deepEqual(assessGoal(complete, store.evidence(wf.workflowId, root, proofIds)).verifiedCriteria, [0, 1]);
    writeFileSync(join(root, "README.md"), "other docs\n");
    assert.deepEqual(assessGoal(complete, store.evidence(wf.workflowId, root, proofIds)).verifiedCriteria, [0, 1],
      "a docs-only edit must not invalidate code tests");
    writeFileSync(join(root, "src", "helper.ts"), "export const helper = 2;\n");
    assert.deepEqual(assessGoal(complete, store.evidence(wf.workflowId, root, proofIds)).verifiedCriteria, [],
      "an imported dependency change must invalidate the targeted test");
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 2;\n");
    assert.deepEqual(assessGoal(complete, store.evidence(wf.workflowId, root, proofIds)).verifiedCriteria, [],
      "a relevant code change must invalidate prior evidence");
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("unverifiable criteria and legacy evidence do not prove completion", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "UI", goal: "verify visible host", constraints: [],
      acceptanceCriteria: ["Real ChatGPT resume button works", "test passes"],
    });
    const old = store.observe(root, wf.workflowId, {
      eventKey: "legacy", kind: "verification", status: "completed", exitCode: 0,
    });
    const status = assessGoal({ ...wf, checkpoint: { ...wf.checkpoint,
      criterionEvidence: [{ criterion: 0, eventId: old.eventId }, { criterion: 1, eventId: old.eventId }],
    } }, store.evidence(wf.workflowId, root));
    assert.deepEqual(status.verifiedCriteria, []);
    assert.deepEqual(status.criterionStates, ["requires_confirmation", "unverified"]);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("a generic unit-test command is not independent integration-test evidence", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "integrate", goal: "verify integration", constraints: [],
      acceptanceCriteria: ["integration tests pass"],
    });
    const evidence = store.observe(root, wf.workflowId, {
      eventKey: "run:unit", kind: "verification", status: "completed", exitCode: 0,
      command: "pnpm test", source: "exec_command", verificationScope: [],
    });
    const attempted = { ...wf, checkpoint: { ...wf.checkpoint,
      criterionEvidence: [{ criterion: 0, eventId: evidence.eventId }],
    } };
    assert.deepEqual(assessGoal(attempted, store.evidence(wf.workflowId, root, [evidence.eventId])).verifiedCriteria, []);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("an active process without taskId blocks finish; terminal status cannot regress", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, { title: "job", goal: "verify", constraints: [], acceptanceCriteria: ["test passes"] });
    store.observe(root, wf.workflowId, { eventKey: "run:tty", kind: "command", status: "running", runId: "run_tty" });
    let goal = assessGoal(wf, store.evidence(wf.workflowId, root));
    assert.deepEqual(goal.pendingOperations, ["run_tty"]);
    assert.equal(goal.status, "in_progress");
    store.observe(root, wf.workflowId, { eventKey: "run:tty", kind: "command", status: "cancelled", runId: "run_tty" });
    store.observe(root, wf.workflowId, { eventKey: "run:tty", kind: "command", status: "running", runId: "run_tty" });
    goal = assessGoal(wf, store.evidence(wf.workflowId, root));
    assert.deepEqual(goal.pendingOperations, []);
    assert.equal(store.evidence(wf.workflowId, root).find(e => e.runId === "run_tty")?.status, "cancelled");
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("continuity database failure never masks a successful primary operation", () => {
  const { root, state } = repository();
  try {
    const original = { content: [{ type: "text", text: "patch applied" }], structuredContent: { files: ["ok.ts"] } };
    assert.strictEqual(withWorkflowReceipt({ stateDir: state, workspaceRoot: root,
      workspaceId: "ws_test123", conversationScope: "s", enabled: false }, original), original);
    const broken = withWorkflowReceipt({ stateDir: join(state, "README-not-a-dir"), workspaceRoot: root,
      workspaceId: "ws_test123", conversationScope: "s", workflowId: "wf_aaaaaaaaaaaaaaaaaaaaaaaa" }, original);
    assert.deepEqual(broken.content, original.content);
    assert.deepEqual(broken.structuredContent.files, original.structuredContent.files);
    assert.match(String((broken.structuredContent as Record<string, unknown>).continuityWarning), /Non-blocking continuity record failed/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("a durable task's later receipt resolves the original command without losing its verification scope", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, { title: "test", goal: "test", constraints: [], acceptanceCriteria: ["test passes"] });
    store.observe(root, wf.workflowId, {
      eventKey: "run:detached", kind: "verification", status: "working", taskId: "task_test123",
      runId: "run_detached", command: "pnpm test", verificationScope: [], source: "exec_command",
    });
    const completed = store.observe(root, wf.workflowId, {
      eventKey: "run:detached", kind: "command", status: "completed", taskId: "task_test123",
      runId: "run_detached", source: "task_receipt", exitCode: 0,
    });
    assert.equal(completed.kind, "verification");
    assert.equal(completed.command, "pnpm test");
    assert.equal(completed.source, "exec_command");
    assert.ok(completed.fingerprint);
    const proposed = { ...wf, checkpoint: { ...wf.checkpoint,
      criterionEvidence: [{ criterion: 0, eventId: completed.eventId }],
    } };
    assert.deepEqual(assessGoal(proposed, store.evidence(wf.workflowId, root, [completed.eventId])).verifiedCriteria, [0]);
    assert.deepEqual(assessGoal(proposed, store.evidence(wf.workflowId, root, [completed.eventId])).pendingOperations, []);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("a verification started before a code edit cannot validate the newer tree at task completion", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "race", goal: "race", acceptanceCriteria: ["feature test passes"], constraints: [],
    });
    const command = "pnpm exec tsx --test src/feature.test.ts";
    const started = store.observe(root, wf.workflowId, {
      eventKey: "run:slow", kind: "verification", status: "running",
      runId: "run_slow", taskId: "task_slow", command,
      verificationScope: verificationScope(command), source: "exec_command",
    });
    assert.ok(started.fingerprint, "capture the source fingerprint before the task finishes");
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = 27;\n");
    const finished = store.observe(root, wf.workflowId, {
      eventKey: "run:slow", kind: "command", status: "completed",
      runId: "run_slow", taskId: "task_slow", exitCode: 0, source: "task_receipt",
    });
    assert.equal(finished.fingerprint, started.fingerprint, "a late receipt must not re-fingerprint modified code");
    const proposed = { ...wf, checkpoint: { ...wf.checkpoint,
      criterionEvidence: [{ criterion: 0, eventId: finished.eventId }],
    } };
    const evidence = store.evidence(wf.workflowId, root, [finished.eventId]);
    assert.equal(evidence.find(e => e.eventId === finished.eventId)?.stale, true);
    assert.deepEqual(assessGoal(proposed, evidence).verifiedCriteria, []);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("evidence retrieval stays bounded even with many historical events", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, { title: "load", goal: "load", constraints: [], acceptanceCriteria: ["test passes"] });
    for (let i = 0; i < 400; i++) store.observe(root, wf.workflowId, {
      eventKey: `run:${i}`, kind: "command", status: "completed", runId: `run_${i}`, exitCode: 0,
    });
    assert.ok(store.evidence(wf.workflowId, root).length <= 64);
    for (let i = 0; i < 260; i++) store.observe(root, wf.workflowId, {
      eventKey: `pending:${i}`, kind: "command", status: "running", runId: `run_pending${i}`,
    });
    const status = assessGoal(wf, store.evidence(wf.workflowId, root));
    assert.equal(status.status, "in_progress");
    assert.ok(status.pendingOperations.length > 0);
    assert.ok(store.evidence(wf.workflowId, root).length <= 64 + 256 + 1);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("terminal checkpoint task receipts remain discoverable beyond the recent event window", () => {
  const { root, state } = repository();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, {
      title: "old task", goal: "old task", acceptanceCriteria: ["test passes"], constraints: [],
    });
    const terminal = store.observe(root, wf.workflowId, {
      eventKey: "run:old", kind: "command", status: "cancelled",
      runId: "run_old", taskId: "task_old",
    });
    const updated = store.checkpoint(root, {
      workflowId: wf.workflowId, expectedRevision: 0, status: "active",
      checkpoint: { phase: "verify", summary: "stale checkpoint", completedSteps: [],
        nextSteps: [], blockers: [], checks: [], taskIds: ["task_old"] },
    });
    for (let i = 0; i < 110; i++) store.observe(root, wf.workflowId, {
      eventKey: `run:noise${i}`, kind: "command", status: "completed", runId: `run_noise${i}`,
    });
    const visible = store.evidence(wf.workflowId, root);
    assert.ok(visible.some(e => e.eventId === terminal.eventId));
    assert.deepEqual(assessGoal(updated, visible).pendingTaskIds, []);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test("legacy workflow evidence schema migrates in place without inventing missing provenance", () => {
  const { root, state } = repository();
  const file = join(state, "coding-workflows.sqlite");
  const previous = new Database(file);
  previous.exec(`create table coding_workflow_evidence (
    event_id text primary key, workflow_id text not null, event_key text not null,
    kind text not null, status text not null, run_id text, task_id text,
    exit_code integer, observed_at text not null, unique(workflow_id, event_key)
  )`);
  previous.close();
  const store = new CodingWorkflowStore(state);
  try {
    const wf = store.create(root, { title: "legacy", goal: "legacy", acceptanceCriteria: ["test passes"], constraints: [] });
    const old = store.observe(root, wf.workflowId, {
      eventKey: "old", kind: "verification", status: "completed", exitCode: 0,
    });
    const restarted = new CodingWorkflowStore(state);
    try {
      assert.equal(restarted.getRequired(wf.workflowId, root).goal, "legacy");
      assert.equal(restarted.evidence(wf.workflowId, root)[0]?.command, undefined);
      assert.equal(restarted.evidence(wf.workflowId, root)[0]?.eventId, old.eventId);
    } finally { restarted.close(); }
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});
