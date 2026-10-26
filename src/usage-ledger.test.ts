import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db/client.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { LearningStore } from "./learning-store.js";
import { UsageTrafficRecorder, readStoredUsage } from "./usage-ledger.js";
import { summarizeConsoleUsage } from "./console-usage.js";

test("hourly usage survives diagnostic rotation and process-style recorder restart", async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-usage-ledger-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const db = openDatabase(stateDir);
  db.close();
  const first = new UsageTrafficRecorder(stateDir);
  const diagnostics = new DiagnosticTrace(stateDir, 1000, e => first.record(e));
  diagnostics.record("mcp_received", { requestId: "one", inputBytes: 180 });
  diagnostics.record("tool_execution_started", { requestId: "one", tool: "apply_patch" });
  diagnostics.record("mcp_finished", { requestId: "one", outputBytes: 420 });
  assert.equal(first.flush(), true);
  first.close();
  const second = new UsageTrafficRecorder(stateDir);
  const newer = new DiagnosticTrace(stateDir, 1000, e => second.record(e));
  newer.record("mcp_received", { requestId: "two" }); // unknown input size
  newer.record("mcp_finished", { requestId: "two" }); // unknown output size
  for(let i=0;i<18;i++)newer.record("stage_started", { requestId: `noise_${i}`, stage: "auth" });
  assert.equal(second.flush(), true);
  second.close();
  const handle = openDatabase(stateDir);
  const saved = readStoredUsage(handle.sqlite);
  handle.close();
  const totals = saved.hourly.reduce((sum, row) => sum + row.requests, 0);
  assert.equal(totals, 2);
  const report = summarizeConsoleUsage(new DiagnosticTrace(stateDir).read({minutes:1440}), [], Date.now(), undefined, saved);
  const usage = report.periods["24h"];
  assert.equal(usage.requests, 2);
  assert.equal(usage.completed, 2);
  assert.equal(usage.toolExecutions, 1);
  assert.equal(usage.inputBytes, 180);
  assert.equal(usage.outputBytes, 420);
  assert.equal(usage.measuredInput, 1);
  assert.equal(usage.measuredOutput, 1);
  assert.equal(usage.topTools[0]?.tool, "apply_patch");
  assert.ok(report.source.trafficPersistedFrom);
});

test("Git review persistence deduplicates references beyond learning record lifetime", async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-usage-review-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const learning = new LearningStore(stateDir);
  const source = { structuredContent: { reviewRef: "d".repeat(40), result: "reviewed" },
    _meta: { card: { summary: { files: 2, additions: 9, removals: 3 },
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } } };
  for(let i=0;i<3;i++)learning.recordToolCall({ workspaceRoot: "/tmp/alpha-project", tool: "show_changes",
    toolInput: { workspaceId: "test" }, toolOutput: source });
  const db = openDatabase(stateDir);
  const stored = readStoredUsage(db.sqlite);
  assert.equal(stored.reviews.length, 1);
  db.sqlite.prepare("delete from learning_episodes").run();
  db.close();
  const usage = summarizeConsoleUsage([], [], Date.now(), undefined, stored);
  const totals = usage.periods["24h"];
  assert.equal(totals.gitReviews, 1);
  assert.equal(totals.addedLines, 9);
  assert.equal(totals.removedLines, 3);
  assert.equal(totals.projects[0]?.name, "alpha-project");
  assert.equal(totals.projects[0]?.uniqueFiles, 2);
  assert.equal(totals.distinctReviewedFiles, 2);
});

test("usage recorder fails open when analytics database is unavailable", async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-usage-fail-open-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const recorder = new UsageTrafficRecorder(stateDir);
  assert.doesNotThrow(() => recorder.record({ ts: new Date().toISOString(), event: "mcp_received", requestId: "one" }));
  assert.equal(recorder.flush(), false);
  recorder.close();
});
