import assert from "node:assert/strict";
import { test } from "node:test";
import { newOtelContext, parseTraceparent } from "./otel-context.js";
import { runWithRequestLogContext } from "./logger.js";
import { traceStage } from "./trace-stages.js";
import { sanitizeDiagnostic, type DiagnosticEntry } from "./diagnostic-trace.js";

test("W3C context handles valid and malicious headers without changing old IDs", () => {
  const parent = "00-0123456789abcdef0123456789abcdef-abcdef0123456789-01";
  assert.deepEqual(parseTraceparent(parent), {
    traceId: "0123456789abcdef0123456789abcdef", parentSpanId: "abcdef0123456789",
  });
  const context = newOtelContext(parent);
  assert.equal(context.otelTraceId, "0123456789abcdef0123456789abcdef");
  assert.equal(context.otelParentSpanId, "abcdef0123456789");
  assert.match(context.otelSpanId, /^[0-9a-f]{16}$/);
  for (const value of ["00-" + "0".repeat(32) + "-abcdef0123456789-01",
    "00-0123456789abcdef0123456789abcdef-0000000000000000-01",
    "hello\nworld", "00-aaaa-bbbb-01", "ff-0123456789abcdef0123456789abcdef-abcdef0123456789-01"]) {
    assert.equal(parseTraceparent(value), undefined);
  }
  assert.match(newOtelContext("garbage").otelTraceId, /^[a-f0-9]{32}$/);
});

test("nested execution stages preserve parent-child spans and metadata-only diagnostics", async () => {
  const root = newOtelContext();
  const events: DiagnosticEntry[] = [];
  await runWithRequestLogContext({
    requestId: "legacy-uuid", traceId: "legacy-uuid", path: "/mcp", ...root,
    emitDiagnostic: (event, fields) => events.push(sanitizeDiagnostic(event, fields)),
  }, async () => traceStage("mcp_dispatch", async () => {
    await traceStage("tool_handler", async () => "result", { body: "secret content" });
  }));
  assert.equal(events.length, 4);
  assert.ok(events.every(e => e.traceId === "legacy-uuid" && e.otelTraceId === root.otelTraceId));
  const dispatch = events.find(e => e.event === "stage_started" && e.stage === "mcp_dispatch")!;
  const tool = events.find(e => e.event === "stage_started" && e.stage === "tool_handler")!;
  assert.equal(dispatch.otelParentSpanId, root.otelSpanId);
  assert.equal(tool.otelParentSpanId, dispatch.otelSpanId);
  assert.notEqual(tool.otelSpanId, dispatch.otelSpanId);
  assert.ok(!JSON.stringify(events).includes("secret content"));
});
