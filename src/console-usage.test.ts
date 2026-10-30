import assert from "node:assert/strict";
import test from "node:test";
import { summarizeConsoleUsage } from "./console-usage.js";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

test("usage separates MCP payload estimates from unavailable model tokens", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const item = (requestId: string, event: DiagnosticEntry["event"], extra: Partial<DiagnosticEntry> = {}): DiagnosticEntry =>
    ({ ts: "2026-10-26T11:00:00Z", requestId, event, ...extra });
  const result = summarizeConsoleUsage([
    item("request-1", "mcp_received", { inputBytes: 400 }),
    item("request-1", "tool_execution_started", { tool: "apply_patch" }),
    item("request-1", "mcp_finished", { outputBytes: 800 }),
    item("request-2", "mcp_received", { inputBytes: 100 }),
    item("request-2", "mcp_closed_early"),
  ], [], now);
  assert.equal(result.periods["24h"].requests, 2);
  assert.equal(result.periods["24h"].completed, 1);
  assert.equal(result.periods["24h"].inputBytes, 500);
  assert.equal(result.periods["24h"].outputBytes, 800);
  assert.equal(result.periods["24h"].payloadTokenEquivalentInput, 125);
  assert.deepEqual(result.periods["24h"].topTools, [{ tool: "apply_patch", calls: 1 }]);
  assert.equal(result.inference.inputTokens, null);
  assert.equal(result.inference.outputTokens, null);
  assert.equal(result.periods["24h"].gitReviews, 0);
});

test("usage deduplicates reviewed Git snapshots and records uncovered edits separately", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const marker = JSON.stringify({ reviewRef: "b".repeat(40), files: 2, additions: 12, removals: 7,
    pathHashes: ["a".repeat(20), "c".repeat(20)], pathsComplete: true });
  const review = { workspace_root: "/repo", tool: "show_changes", success: 1,
    output_summary: "2 files changed\n@@synrex-usage:" + marker, created_at: "2026-10-26T11:00:00Z" };
  const result = summarizeConsoleUsage([], [review, review,
    { ...review, tool: "semantic_edit", output_summary: "ok" },
    { ...review, success: 0, output_summary: "failed" },
  ], now);
  assert.equal(result.periods["24h"].gitReviews, 1);
  assert.equal(result.periods["24h"].reviewedFileTouches, 2);
  assert.equal(result.periods["24h"].distinctReviewedFiles, 2);
  assert.equal(result.periods["24h"].addedLines, 12);
  assert.equal(result.periods["24h"].removedLines, 7);
  assert.equal(result.periods["24h"].otherEditOperations, 1);
});
