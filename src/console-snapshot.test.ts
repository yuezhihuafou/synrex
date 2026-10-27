import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "./db/client.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { readConsoleSnapshot } from "./console-snapshot.js";
import { DIAGNOSTIC_FILE_LIMIT, DiagnosticTrace } from "./diagnostic-trace.js";
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
  assert.equal(snapshot.dataFreshness.sampledAt, snapshot.generatedAt);
  assert.equal(snapshot.dataFreshness.nodes, "2026-10-20T00:02:00.000Z");
  assert.ok(snapshot.dataFreshness.workflows && Number.isFinite(Date.parse(snapshot.dataFreshness.workflows)));
  assert.equal(snapshot.dataFreshness.tasks, null, "task route without a verified local task is not source activity");
  assert.ok(snapshot.dataFreshness.diagnostics, "recent diagnostic events retain their original timestamp");
  assert.equal(snapshot.service.diagnosticsBoundBytes, DIAGNOSTIC_FILE_LIMIT * 2);
  assert.equal(snapshot.activeTaskProcesses?.length ?? 0, snapshot.activeTaskUnits?.length ?? 0);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.memory.episodes, 0);
  assert.equal(snapshot.execution.manualReminders, null, "cannot count ChatGPT user interventions from server telemetry");
  assert.equal(snapshot.execution.selfReportedCompletionRate, null, "no terminal workflow denominator");
  assert.equal(snapshot.workflows[0]?.acceptanceCriteria[0], "All tests pass");
});

test("console reports observed failure timeline and never calls remote tasks running without owner evidence", async(t) => {
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-console-evidence-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=openDatabase(dir);
  try{
    for(const [id,kind] of [["node_local","local"],["node_gateway","remote"]] as const){
      db.sqlite.prepare(`insert into execution_nodes
        (id,kind,alias,protocol_major,protocol_minor,health,platform_json,capabilities_json,created_at,last_seen_at)
        values (?,?,?,?,?,?,?,?,?,?)`).run(id,kind,kind,1,1,"online",'{"os":"linux","arch":"x64"}',
          '{"toolMode":"codex","features":[]}',"2026-10-26T00:00:00Z","2026-10-26T00:00:00Z");
    }
    db.sqlite.prepare(`insert into workspace_routes(workspace_id,node_id,local_workspace_id,created_at,last_used_at)
      values ('ws_rem','node_gateway','ws_local','2026-10-26','2026-10-26')`).run();
    db.sqlite.prepare(`insert into task_routes(task_id,node_id,workspace_id,local_task_id,run_id,created_at,last_used_at)
      values ('task_remote','node_gateway','ws_rem','task_local','run_20261026123456_aaaa','2026-10-26','2026-10-26')`).run();
  } finally{db.close();}
  const events=new DiagnosticTrace(dir);
  events.record("task_finished",{ taskId:"task_id",runId:"run_20261026123456_aaaa",exitCode:7 });
  events.record("tool_execution_finished",{requestId:"r_1",tool:"exec_command",outcome:"error",errorCategory:"command_exit",exitCode:7});
  const snapshot=readConsoleSnapshot(dir,"release");
  assert.equal(snapshot.tasks[0]?.status,"remote_unverified");
  assert.equal(snapshot.tasks[0]?.statusSource,"unavailable");
  assert.equal(snapshot.execution.confirmedTaskFailures,1);
  assert.equal(snapshot.execution.confirmedTaskSuccesses,0);
  assert.equal(snapshot.execution.failureCategories.command_exit,1);
  assert.ok(snapshot.timeline.some(e=>e.kind==="task_finished"&&e.exitCode===7));
  assert.equal(snapshot.execution.manualReminders,null);
});

test("console exposes local task output time and PID only from a verified local task file", async(t)=>{
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-console-local-task-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id="run_20261026123456_abcd";
  const runRoot=path.join(dir,"runs");
  const runDir=path.join(runRoot,"2026-10-26",id);
  await mkdir(runDir,{recursive:true});
  const now=new Date().toISOString();
  const lastActivity=new Date(Date.now()-5000).toISOString();
  await writeFile(path.join(runDir,"task.json"),JSON.stringify({status:"working",
    lastUpdatedAt:now,lastActivityAt:lastActivity,childPid:43210,exitCode:null}));
  const previous=process.env.DEVSPACE_COMPACT_RUN_ROOT;
  process.env.DEVSPACE_COMPACT_RUN_ROOT=runRoot;
  t.after(()=>{if(previous===undefined)delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
    else process.env.DEVSPACE_COMPACT_RUN_ROOT=previous;});
  const db=openDatabase(dir);
  try{
    db.sqlite.prepare(`insert into execution_nodes
      (id,kind,alias,protocol_major,protocol_minor,health,platform_json,capabilities_json,created_at,last_seen_at)
      values (?,?,?,?,?,?,?,?,?,?)`).run("node_local","local","swy1",1,1,"online",
        '{"os":"linux","arch":"x64"}','{"toolMode":"codex","features":[]}',now,now);
    db.sqlite.prepare(`insert into workspace_routes(workspace_id,node_id,local_workspace_id,created_at,last_used_at)
      values ('ws_local','node_local','ws_local',?,?)`).run(now,now);
    db.sqlite.prepare(`insert into task_routes(task_id,node_id,workspace_id,local_task_id,run_id,created_at,last_used_at)
      values ('task_local','node_local','ws_local','task_local',?,?,?)`).run(id,now,now);
  }finally{db.close();}
  const snapshot=readConsoleSnapshot(dir,"local");
  const task=snapshot.tasks[0]!;
  assert.equal(task.status,"working");
  assert.equal(task.statusSource,"local_file");
  assert.equal(task.childPid,43210);
  assert.equal(task.lastActivityAt,lastActivity);
  assert.equal(task.lastUpdatedAt,now);
  assert.equal(snapshot.dataFreshness.tasks,lastActivity,
    "source freshness must use observed task activity rather than the snapshot collection time");
  assert.notEqual(snapshot.dataFreshness.tasks,snapshot.dataFreshness.sampledAt);
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

test("console usage reads numeric Git review evidence from existing learning store", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-console-usage-"));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const learning = new LearningStore(stateDir);
  const toolOutput = {
    structuredContent: { reviewRef: "a".repeat(40), result: "2 files changed" },
    _meta: { card: { summary: { files: 2, additions: 20, removals: 4 },
      files: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
      payload: { patch: "secret code should not be persisted" } } },
  };
  learning.recordToolCall({ workspaceRoot: "/tmp/usage-project", tool: "show_changes",
    toolInput: { workspaceId: "ws_1" }, toolOutput });
  learning.recordToolCall({ workspaceRoot: "/tmp/usage-project", tool: "show_changes",
    toolInput: { workspaceId: "ws_1" }, toolOutput });
  const snapshot = readConsoleSnapshot(stateDir, "candidate");
  const usage = snapshot.usage.periods["24h"];
  assert.equal(usage.gitReviews, 1);
  assert.equal(usage.reviewedFileTouches, 2);
  assert.equal(usage.addedLines, 20);
  assert.equal(usage.removedLines, 4);
  assert.equal(usage.distinctReviewedFiles, 2);
  const db = openDatabase(stateDir);
  try {
    const text = (db.sqlite.prepare("select output_summary from learning_episodes limit 1")
      .get() as { output_summary: string }).output_summary;
    assert.doesNotMatch(text, /src\/one\.ts|secret code/);
  } finally { db.close(); }
});
