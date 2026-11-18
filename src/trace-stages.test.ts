import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRequestLogContext } from "./logger.js";
import { traceStage, errorCategory, transportErrorCode } from "./trace-stages.js";
import { DiagnosticTrace, sanitizeDiagnostic, summarizeDiagnosticTrace, type DiagnosticEntry } from "./diagnostic-trace.js";
import { diagnosticTimings, readRunTrace } from "./diagnostic-report.js";
import { recordTaskTrace } from "./task-trace.js";
import { NodeLinkHub } from "./multinode/link-hub.js";

test("nested fetch connection errors retain safe network codes without persisting messages", () => {
  const timeout = new TypeError("fetch failed: secret-proxy-host", {
    cause: Object.assign(new Error("private-route-info"), { code: "ETIMEDOUT" }),
  });
  assert.equal(errorCategory(timeout), "timeout");
  assert.equal(transportErrorCode(timeout), "ETIMEDOUT");
  const details = sanitizeDiagnostic("node_transport", {
    stage: "peer_poll", outcome: "error", errorCategory: errorCategory(timeout),
    errorCode: transportErrorCode(timeout), token: "private", message: String(timeout),
  });
  assert.equal(details.stage, "peer_poll");
  assert.equal(details.errorCategory, "timeout");
  assert.equal(details.errorCode, "ETIMEDOUT");
  assert.ok(!JSON.stringify(details).includes("secret-proxy-host"));
  assert.equal(errorCategory(new TypeError("fetch failed", {
    cause: Object.assign(new Error("DNS"), { code: "EAI_AGAIN" }),
  })), "transport");
  assert.equal(errorCategory(new TypeError("fetch failed", {
    cause: new AggregateError([
      Object.assign(new Error("private IPv6 route"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("private IPv4 route"), { code: "ENETUNREACH" }),
    ], "sensitive addresses"),
  })), "timeout");
  assert.equal(sanitizeDiagnostic("node_transport", { errorCode: "SECRET_VALUE" }).errorCode, undefined);
  assert.equal(errorCategory(Object.assign(new Error("unauthorized"), { status: 401 })), "auth");
  assert.equal(errorCategory(Object.assign(new Error("upstream gateway unavailable"), { status: 503 })), "transport");
});

test("concurrent phase traces preserve request identity and redact arbitrary errors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "synrex-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const d = new DiagnosticTrace(root);
  await Promise.all(["req_a", "req_b"].map((requestId) => runWithRequestLogContext({
    requestId, traceId: requestId, path: "/mcp", emitDiagnostic: (event, fields) => d.record(event, fields),
  }, async () => {
    await assert.rejects(traceStage("tool_handler", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error("secret-user-content"), { code: "ENOENT" });
    }));
  })));
  const entries = d.read();
  assert.equal(entries.length, 4);
  for (const id of ["req_a", "req_b"]) {
    const chain = entries.filter((x) => x.requestId === id);
    assert.equal(chain.length, 2);
    assert.ok(chain.every((x) => x.traceId === id));
    assert.equal(chain[1]?.errorCategory, "not_found");
  }
  assert.ok(!(await readFile(d.file, "utf8")).includes("secret-user-content"));
  assert.equal(diagnosticTimings(entries)[0]?.count, 2);
});

test("node queue, delivery and completion join the ingress trace", async () => {
  assert.equal(sanitizeDiagnostic("node_peer_finished", { outcome: "error" }).outcome, "error");
  assert.equal(sanitizeDiagnostic("node_peer_finished", { outcome: "ok" }).outcome, "ok");
  const events: DiagnosticEntry[] = [];
  const hub = new NodeLinkHub(2000, 1000, (event, fields) => events.push(sanitizeDiagnostic(event, fields)));
  try {
    const call = runWithRequestLogContext({ requestId: "ingress", traceId: "ingress", path: "/mcp" }, () => hub.call("node_test", { name: "read", arguments: {} }));
    const request = await hub.poll("node_test", 5);
    assert.ok(request);
    assert.equal(request.call.meta?.["devspace/traceId"], "ingress");
    hub.complete("node_test", request.id, { isError: false });
    await call;
    assert.deepEqual(events.map((x) => x.event), ["node_queued", "node_delivered", "node_completed"]);
    assert.ok(events.every((x) => x.traceId === "ingress" && x.nodeRequestId === request.id));
  } finally { hub.close(); }
});

test("late postprocessing does not change completed HTTP classification", () => {
  const ts = new Date().toISOString();
  const entries: DiagnosticEntry[] = [
    { ts, event: "mcp_finished", requestId: "http", status: 200 },
    { ts, event: "stage_finished", requestId: "remote", traceId: "http", stage: "routing", durationMs: 10 },
  ];
  const report = summarizeDiagnosticTrace(entries);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0]?.classification, "rev_http_completed");
});

test("per-run trace survives a new reader without persisting task contents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "synrex-run-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "run_20261022120000_1234abcd";
  const dir = path.join(root, "2026-10-22", runId);
  await mkdir(dir, { recursive: true });
  recordTaskTrace(dir, "task_finished", { requestId: "http", traceId: "http", runId,
    taskId: "task_1234abcd", outcome: "error", exitCode: 7, errorCategory: "command_exit", command: "secret command", output: "secret result" });
  const entries = readRunTrace(runId, root);
  assert.equal(entries[0]?.exitCode, 7);
  assert.equal(entries[0]?.traceId, "http");
  assert.ok(!(await readFile(path.join(dir, "trace.jsonl"), "utf8")).includes("secret"));
  assert.throws(() => readRunTrace("../../secret", root), /Invalid run/);
});
