import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "./db/client.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { readDelegationMetrics } from "./console-delegation.js";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

test("delegation metrics join observed workspace MCP calls with bounded local agent turns", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "synrex-console-delegation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Agent telemetry is additive and created by the on-demand daemon.
  new LocalAgentStore(dir).close();
  const db = openDatabase(dir);
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const recent = "2026-10-27T11:00:00.000Z";
  try {
    db.sqlite.prepare(`insert into local_agent_sessions
      (id,workspace_id,workspace_root,profile_name,provider,status,created_at,updated_at)
      values (?,?,?,?,?,?,?,?)`).run("agt_test", "ws_good", dir, "inspector", "codex", "idle", recent, recent);
    db.sqlite.prepare(`insert into local_agent_events (agent_id,at,kind,duration_ms)
      values (?,?,?,?)`).run("agt_test", recent, "turn_completed", 1200);
    db.sqlite.prepare(`insert into local_agent_events (agent_id,at,kind,duration_ms)
      values (?,?,?,?)`).run("agt_test", recent, "turn_failed", 800);
  } finally { db.close(); }
  const events: DiagnosticEntry[] = [
    { event: "tool_execution_started", ts: recent, workspaceId: "ws_good", tool: "read" },
    { event: "tool_execution_started", ts: recent, workspaceId: "ws_other", tool: "exec_command" },
    { event: "tool_execution_finished", ts: recent, workspaceId: "ws_good", tool: "read" },
    { event: "tool_execution_started", ts: "2026-10-25T00:00:00.000Z", workspaceId: "ws_other" },
  ];
  const result = readDelegationMetrics(dir, events, now);
  assert.equal(result.totals.observedMcpToolCalls, 2);
  assert.equal(result.totals.agentSessionsStarted, 1);
  assert.equal(result.totals.agentTurnsCompleted, 1);
  assert.equal(result.totals.agentTurnsFailed, 1);
  assert.equal(result.totals.agentExecutionMs, 2000);
  assert.equal(result.totals.agentTurnSuccessPercent, 50);
  assert.equal(result.totals.userTaskSuccessPercent, null);
  assert.equal(result.workspaces.find(w=>w.workspaceId==="ws_good")?.observedMcpToolCalls, 1);
  assert.equal(result.agentTasks[0]?.agentId, "agt_test");
  assert.equal(result.source.agentsAvailable, true);
});

test("delegation metrics do not invent missing agent records or user-goal completion", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "synrex-console-no-agent-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = readDelegationMetrics(dir, [], Date.parse("2026-10-27T12:00:00Z"), true);
  assert.equal(result.source.agentsAvailable, false);
  assert.equal(result.source.diagnosticsCapped, true);
  assert.equal(result.totals.agentTurnSuccessPercent, null);
  assert.equal(result.totals.userTaskSuccessPercent, null);
});
