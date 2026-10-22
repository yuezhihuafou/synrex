import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTIC_FILE_LIMIT,
  DiagnosticTrace,
  sanitizeDiagnostic,
  summarizeDiagnosticTrace,
} from "./diagnostic-trace.js";

test("small persistent diagnostic log keeps only safe metadata and correlates requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rev-diagnostics-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(root);
  const requestId = "request-123";
  diagnostics.record("mcp_received", { requestId, body: "secret prompt", token: "sensitive" });
  diagnostics.record("tool_execution_started", {
    requestId, callId: "call-123", tool: "exec_command", workspaceId: "ws_123",
    command: "cat ~/.ssh/id_rsa", patch: "private code",
  });
  diagnostics.record("tool_execution_finished", {
    requestId, callId: "call-123", tool: "exec_command", outcome: "ok",
    taskId: "task_abcdef0123456789", runId: "run_20261020_test",
    durationMs: 45,
    error: "contains private token",
  });
  diagnostics.record("mcp_finished", { requestId, durationMs: 50, status: 200, url: "/mcp?access_token=secret" });

  const raw = await readFile(diagnostics.file, "utf8");
  for (const secret of ["secret prompt", "sensitive", "cat ~/.ssh/id_rsa", "private code", "private token", "access_token"]) {
    assert.ok(!raw.includes(secret), `must not persist ${secret}`);
  }
  assert.equal((await stat(diagnostics.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "diagnostics"))).mode & 0o777, 0o700);
  const events = new DiagnosticTrace(root).read();
  assert.equal(events.length, 4);
  assert.deepEqual(summarizeDiagnosticTrace(events).requests, [{
    requestId,
    lastEvent: "mcp_finished",
    tool: "exec_command",
    callId: "call-123",
    status: 200,
    taskId: "task_abcdef0123456789",
    runId: "run_20261020_test",
    lastAt: events.at(-1)!.ts,
    classification: "rev_http_completed",
  }]);
  assert.equal(sanitizeDiagnostic("mcp_failed", { requestId: "../../private" }).requestId, undefined);
  assert.equal(sanitizeDiagnostic("mcp_received", { method: "POST", responseMode: "json" }).method, "POST");
  assert.equal(sanitizeDiagnostic("mcp_received", { method: "POST /mcp?token=secret" }).method, undefined);
  assert.equal(sanitizeDiagnostic("mcp_stream_closed", { responseMode: "sse" }).responseMode, "sse");
});

test("diagnostic trace rotates at its configured bound and caps retained data to two files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rev-diag-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(root, 64 * 1024);
  // Only a small number of bytes are stored per event. Exercise rotation
  // without needing to write any sensitive payload.
  for (let i = 0; i < 14_000; i++) {
    diagnostics.record("tool_execution_started", {
      requestId: `req_${i}`, callId: `call_${i}`,
      tool: "read", workspaceId: "ws_1",
    });
  }
  const first = await stat(diagnostics.file);
  const second = await stat(diagnostics.previousFile);
  assert.ok(first.size <= DIAGNOSTIC_FILE_LIMIT);
  assert.ok(second.size <= DIAGNOSTIC_FILE_LIMIT);
  assert.ok(first.size <= 64 * 1024);
  assert.ok(second.size <= 64 * 1024);
  const recent = diagnostics.read({ minutes: 5, limit: 3 });
  assert.equal(recent.length, 3);
  assert.equal(recent.at(-1)?.requestId, "req_13999");
});

test("last tool result without HTTP completion is identifiable, not falsely called an MCP hang", () => {
  const events = [
    { ts: new Date().toISOString(), event: "mcp_received" as const, requestId: "r_1" },
    { ts: new Date().toISOString(), event: "tool_execution_finished" as const, requestId: "r_1", tool: "read", callId: "c_1" },
    { ts: new Date().toISOString(), event: "mcp_closed_early" as const, requestId: "r_2" },
  ];
  const report = summarizeDiagnosticTrace(events);
  assert.equal(report.requests[0]?.classification, "tool_finished_http_not_observed");
  assert.equal(report.requests[1]?.classification, "connection_closed_early");
});

test("explicit chat titles are correlated but never synthesized or accepted from other events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-title-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const d = new DiagnosticTrace(root);
  const id = "conv_" + "a".repeat(32);
  d.record("conversation_labeled", { conversationId: id, conversationTitle: "Synrex问题分析", requestId: "r1" });
  d.record("tool_execution_started", { conversationId: id, tool: "read", requestId: "r1", conversationTitle: "SHOULD_NOT_LEAK" });
  d.record("tool_execution_finished", { conversationId: id, tool: "read", requestId: "r1", outcome: "ok" });
  d.record("mcp_finished", { requestId: "r1", status: 200 });
  const contents = await readFile(d.file, "utf8");
  assert.ok(contents.includes("Synrex问题分析"));
  assert.ok(!contents.includes("SHOULD_NOT_LEAK"));
  const report = summarizeDiagnosticTrace(d.read());
  assert.deepEqual(report.conversations, [{ conversationId: id, conversationTitle: "Synrex问题分析" }]);
  assert.equal(report.requests[0]?.conversationId, id);
  assert.equal(report.requests[0]?.conversationTitle, "Synrex问题分析");
  assert.equal(d.read({ conversationId: "conv_" + "b".repeat(32) }).length, 0);
  assert.equal(d.read({ conversationId: id }).length, 3);
  assert.equal(d.read({ title: "Synrex问题分析" }).length, 4);
  assert.equal(d.read({ title: "unrelated" }).length, 0);
  assert.equal(sanitizeDiagnostic("conversation_labeled", { conversationId: id, conversationTitle: "bad\ntitle" }).conversationTitle, undefined);
});

test("explicit request-only conversation title remains queryable without a host session",async t=>{
  const root=await mkdtemp(join(tmpdir(),"synrex-label-no-session-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const d=new DiagnosticTrace(root);
  d.record("conversation_labeled",{requestId:"owner-request",conversationTitle:"评估全链路日志"});
  d.record("mcp_finished",{requestId:"owner-request",status:200});
  d.record("mcp_finished",{requestId:"neighbor-request",status:200});
  assert.equal(d.read({title:"评估全链路日志"}).length,2);
  assert.equal(d.read({title:"unrelated"}).length,0);
  assert.equal(summarizeDiagnosticTrace(d.read()).requests.find(e=>e.requestId==="owner-request")
    ?.conversationTitle,"评估全链路日志");
});
