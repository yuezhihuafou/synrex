import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConsoleObservability } from "./console-observability.js";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

test("separates completed HTTP, early close, incomplete and unknown host state", () => {
  const entry = (requestId: string, event: DiagnosticEntry["event"], extra: Partial<DiagnosticEntry> = {}): DiagnosticEntry =>
    ({ ts: "2026-10-22T00:00:00Z", requestId, event, ...extra });
  const result = summarizeConsoleObservability([
    entry("a", "mcp_received", { inputBytes: 120 }),
    entry("a", "mcp_finished", { durationMs: 200, outputBytes: 300 }),
    entry("b", "mcp_finished", { durationMs: 50 }),
    entry("c", "mcp_closed_early"), entry("d", "tool_execution_finished"),
    entry("e", "mcp_received"), entry("f", "mcp_failed"),
  ]);
  assert.deepEqual(result.lifecycle, { httpCompleted: 2, closedEarly: 1, handlerFailed: 1, toolCompletedWithoutHttp: 1, unknown: 1 });
  assert.equal(result.latency.medianMs, 50);
  assert.equal(result.latency.p95Ms, 200);
  assert.equal(result.transfer.observedInputBytes, 120);
  assert.equal(result.coverage.tokenUsage, "unavailable");
  assert.equal(result.coverage.hostInference, "unobservable");
});
