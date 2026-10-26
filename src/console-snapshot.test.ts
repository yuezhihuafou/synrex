import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "./db/client.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { readConsoleSnapshot } from "./console-snapshot.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { LearningStore } from "./learning-store.js";

test("console uses existing database read-only and does not invent process status", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "rev-console-snapshot-"));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(`insert into execution_nodes
      (id,kind,alias,protocol_major,protocol_minor,health,platform_json,capabilities_json,created_at,last_seen_at)
      values (?,?,?,?,?,?,?,?,?,?)`).run(
        "node_alpha", "local", "swy1", 1, 1, "online", '{"os":"linux","arch":"x64"}',
        JSON.stringify({ toolMode: "codex", features: [], toolContracts: { open_workspace: 1, exec_command: 1 } }),
        "2026-10-20T00:00:00.000Z", "2026-10-20T00:02:00.000Z",
      );
    database.sqlite.prepare(`insert into execution_nodes
      (id,kind,alias,protocol_major,protocol_minor,health,platform_json,capabilities_json,created_at,last_seen_at)
      values (?,?,?,?,?,?,?,?,?,?)`).run(
        "node_beta", "remote", "gateway", 1, 1, "offline", '{"os":"linux","arch":"x64"}',
        JSON.stringify({ toolMode: "codex", features: [], toolContracts: { open_workspace: 1 } }),
        "2026-10-20T00:00:00.000Z", "2026-10-20T00:01:00.000Z",
      );
  } finally { database.close(); }
  const store = new CodingWorkflowStore(stateDir);
  try {
    store.create("/tmp/rev-console-project", {
      title: "Build", goal: "Finish tested coding change",
      acceptanceCriteria: ["All tests pass"], constraints: [],
    });
  } finally { store.close(); }
  const diagnostic = new DiagnosticTrace(stateDir);
  diagnostic.record("mcp_received", { requestId: "req_1" });
  diagnostic.record("mcp_finished", { requestId: "req_1", status: 200 });
  const snapshot = readConsoleSnapshot(stateDir, "test-release");
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.nodes.find((node) => node.alias === "gateway")?.health, "offline");
  assert.equal(snapshot.nodes.find((node) => node.alias === "gateway")?.contract.missing, 1);
  assert.equal(snapshot.workflows[0]?.title, "Build");
  assert.equal(snapshot.diagnostics.requests[0]?.classification, "rev_http_completed");
  assert.equal(snapshot.service.release, "test-release");
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.memory.episodes, 0);
});

test("console distinguishes historical detached dispatch receipts from verified success", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-console-learning-quality-"));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const learning = new LearningStore(stateDir);
  const workspaceRoot = path.join(stateDir, "project");
  learning.recordNote({ workspaceRoot, taskKey: "incident-1", source: "reflection",
    title: "Test recovery", outcome: "completed", summary: "Recovered test." });
  learning.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "run=run_verified exit=0" } } });
  learning.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "run=run_legacy exit=0" } } });
  const database = openDatabase(stateDir);
  try {
    const row = database.sqlite.prepare("select id from learning_episodes where workspace_root = ? order by rowid desc limit 1")
      .get(workspaceRoot) as { id: string };
    database.sqlite.prepare("update learning_episodes set output_summary = ? where id = ?")
      .run("task=task_1234abcd working poll=5000ms", row.id);
  } finally { database.close(); }
  const snapshot = readConsoleSnapshot(stateDir, "test-release");
  assert.equal(snapshot.memory.episodes, 2);
  assert.equal(snapshot.memory.successful, 1);
  assert.equal(snapshot.memory.notes, 1);
});
