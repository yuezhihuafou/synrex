import assert from "node:assert/strict";
import test from "node:test";
import { finalBarrierReceipt } from "./task-final-barrier.js";
import type { DurableTaskView } from "./durable-task-model.js";

const NOW = 100_000;
function view(ageMs: number, status: DurableTaskView["status"] = "working"): DurableTaskView {
  return {
    taskId: "task_0123456789abcdef", status, revision: "abc12345",
    createdAt: new Date(NOW - ageMs).toISOString(),
    lastUpdatedAt: new Date(NOW - ageMs / 2).toISOString(),
    runId: "run_20261020_abc", workspaceId: "ws_1", ttlMs: null,
    outputBytes: 320, outputLines: 4,
  };
}

test("final barrier applies bounded exponential cadence and read-only escalation", () => {
  assert.equal(finalBarrierReceipt(view(0), NOW).nextCheckMs, 2_000);
  assert.equal(finalBarrierReceipt(view(16_000), NOW).nextCheckMs, 4_000);
  assert.equal(finalBarrierReceipt(view(31_000), NOW).nextCheckMs, 8_000);
  assert.equal(finalBarrierReceipt(view(46_000), NOW).nextCheckMs, 16_000);
  const slow = finalBarrierReceipt(view(61_000), NOW);
  assert.equal(slow.stage, "waiting", "a long-lived task with recent output is not a stall");
  assert.equal(slow.nextCheckMs, 32_000);
  assert.equal(slow.action, "wait_or_do_independent_work");
  assert.equal(slow.outputBytes, 320);
  assert.equal(finalBarrierReceipt(view(300_000), NOW).nextCheckMs, 60_000);
  assert.equal(finalBarrierReceipt(view(300_000, "completed"), NOW).nextCheckMs, 0);
  assert.equal(finalBarrierReceipt(view(300_000, "failed"), NOW).stage, "terminal");
  assert.equal(finalBarrierReceipt(view(300_000, "input_required"), NOW).stage, "input_required");
  assert.equal(finalBarrierReceipt(view(300_000, "input_required"), NOW).nextCheckMs, 0);
});

test("last output activity is not hidden by a recent runner heartbeat", () => {
  const silent = {
    ...view(180_000),
    lastUpdatedAt: new Date(NOW - 1_000).toISOString(),
    lastActivityAt: new Date(NOW - 165_000).toISOString(),
  };
  const receipt = finalBarrierReceipt(silent, NOW);
  assert.equal(receipt.stage, "investigate");
  assert.equal(receipt.action, "inspect_logs_and_continue");
  assert.equal(receipt.idleMs, 165_000);
  assert.equal(receipt.elapsedMs, 180_000);
  assert.equal(finalBarrierReceipt({ ...silent, lastActivityAt: undefined }, NOW).idleMs, 1_000);
});
