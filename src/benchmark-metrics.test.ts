import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAgentBenchmark, summarizePairedAgentBenchmark, type AgentBenchmarkRecord } from "./benchmark-metrics.js";

test("agent benchmark summaries keep outcome quality separate from efficiency", () => {
  const base: Omit<AgentBenchmarkRecord, "taskId" | "variant" | "success" | "contextBytes"> = {
    toolCalls: 10,
    retries: 1,
    wallTimeMs: 1000,
    architectureViolations: 0,
    falsePositiveBlocks: 0,
    humanInterventions: 0,
  };
  const summaries = summarizeAgentBenchmark([
    { ...base, taskId: "a", variant: "baseline", success: true, contextBytes: 1000 },
    { ...base, taskId: "b", variant: "baseline", success: false, contextBytes: 3000 },
    { ...base, taskId: "a", variant: "governed", success: true, contextBytes: 1200 },
    { ...base, taskId: "b", variant: "governed", success: true, contextBytes: 1600 },
  ]);
  assert.equal(summaries[0]?.variant, "baseline");
  assert.equal(summaries[0]?.attemptedRuns, 2);
  assert.equal(summaries[0]?.invalidRuns, 0);
  assert.equal(summaries[0]?.successRate, 0.5);
  assert.equal(summaries[0]?.functionalSuccessRate, 0.5);
  assert.equal(summaries[0]?.meanContextBytes, 2000);
  assert.equal(summaries[1]?.variant, "governed");
  assert.equal(summaries[1]?.successRate, 1);
  assert.equal(summaries[1]?.meanContextBytes, 1400);
});

test("infrastructure-invalid runs do not count as model failures", () => {
  const rows: AgentBenchmarkRecord[] = [
    {
      taskId: "ok",
      variant: "governed",
      success: true,
      contextBytes: 100,
      toolCalls: 2,
      retries: 0,
      wallTimeMs: 10,
      architectureViolations: 0,
      falsePositiveBlocks: 0,
      humanInterventions: 0,
    },
    {
      taskId: "transport-reset",
      variant: "governed",
      valid: false,
      invalidReason: "provider transport reset",
      success: false,
      contextBytes: 0,
      toolCalls: 0,
      retries: 5,
      wallTimeMs: 40_000,
      architectureViolations: 0,
      falsePositiveBlocks: 0,
      humanInterventions: 0,
    },
  ];
  const [summary] = summarizeAgentBenchmark(rows);
  assert.equal(summary?.attemptedRuns, 2);
  assert.equal(summary?.invalidRuns, 1);
  assert.equal(summary?.tasks, 1);
  assert.equal(summary?.successRate, 1);
});

test("all-invalid variants report null outcome metrics rather than a false zero percent", () => {
  const [summary] = summarizeAgentBenchmark([{
    taskId: "transport-reset",
    variant: "baseline",
    valid: false,
    invalidReason: "provider transport reset",
    success: false,
    contextBytes: 0,
    toolCalls: 0,
    retries: 5,
    wallTimeMs: 40_000,
    architectureViolations: 0,
    falsePositiveBlocks: 0,
    humanInterventions: 0,
  }]);
  assert.equal(summary?.tasks, 0);
  assert.equal(summary?.successRate, null);
  assert.equal(summary?.meanWallTimeMs, null);
});

test("paired summaries compare the same task run rather than unrelated means", () => {
  const base = {
    contextBytes: 100,
    retries: 0,
    falsePositiveBlocks: 0,
    humanInterventions: 0,
  };
  const records: AgentBenchmarkRecord[] = [
    { ...base, taskId: "a#1", variant: "baseline", success: false, inputTokens: 100, outputTokens: 20, toolCalls: 4, wallTimeMs: 1000, architectureViolations: 1 },
    { ...base, taskId: "a#1", variant: "governed", success: true, inputTokens: 120, outputTokens: 18, toolCalls: 5, wallTimeMs: 1100, architectureViolations: 0 },
    { ...base, taskId: "b#1", variant: "baseline", success: true, inputTokens: 200, outputTokens: 30, toolCalls: 6, wallTimeMs: 1200, architectureViolations: 0 },
    { ...base, taskId: "b#1", variant: "governed", success: true, inputTokens: 210, outputTokens: 28, toolCalls: 5, wallTimeMs: 1000, architectureViolations: 0 },
  ];
  const summary = summarizePairedAgentBenchmark(records);
  assert.equal(summary.pairs, 2);
  assert.equal(summary.governedOnlySucceeded, 1);
  assert.equal(summary.bothSucceeded, 1);
  assert.equal(summary.meanArchitectureViolationDelta, -0.5);
  assert.equal(summary.meanInputTokenDelta, 15);
  assert.equal(summary.meanOutputTokenDelta, -2);
  assert.equal(summary.meanToolCallDelta, 0);
  assert.equal(summary.meanWallTimeDeltaMs, -50);
});
