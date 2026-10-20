import assert from "node:assert/strict";
import test from "node:test";
import { waitForTaskChange } from "./durable-task-wait.js";
import type { DurableTaskView } from "./durable-task-model.js";

function view(status: DurableTaskView["status"], revision: string): DurableTaskView {
  return {
    taskId: "task_test", status, revision, createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(), ttlMs: null, runId: "run_test",
    workspaceId: "ws_test", outputBytes: 0, outputLines: 0,
  };
}

test("bounded wait returns changed revision without launching or cancelling tasks", async () => {
  let calls = 0;
  const result = await waitForTaskChange(
    async () => view("working", ++calls >= 3 ? "changed" : "old"),
    "old", { waitMs: 200, pollMs: 10 },
  );
  assert.equal(result.unchanged, false);
  assert.equal(result.view.revision, "changed");
  assert.equal(calls, 3);
});

test("bounded wait returns compact unchanged signal after deadline", async () => {
  let calls = 0;
  const start = Date.now();
  const result = await waitForTaskChange(async () => { calls++; return view("working", "old"); },
    "old", { waitMs: 40, pollMs: 10 });
  assert.equal(result.unchanged, true);
  assert.ok(calls >= 2);
  assert.ok(Date.now() - start < 350, "wait should not hang beyond the short deadline");
});

test("terminal and input-required statuses return immediately, even with same revision", async () => {
  for (const status of ["completed", "failed", "cancelled", "input_required"] as const) {
    const result = await waitForTaskChange(async () => view(status, "old"), "old", { waitMs: 250 });
    assert.equal(result.unchanged, false);
    assert.equal(result.view.status, status);
  }
});

test("unknown prior revision changes are returned without waiting", async () => {
  const result = await waitForTaskChange(async () => view("working", "new"),
    "outdated", { waitMs: 250 });
  assert.equal(result.unchanged, false);
  assert.equal(result.view.revision, "new");
});

test("state-change event wakes task_wait before the next safety poll", async () => {
  let revision = "old";
  let wake: (() => void) | undefined;
  let closed = false;
  let reads = 0;
  const startedAt = Date.now();
  const completed = waitForTaskChange(async () => {
    reads++;
    return view(revision === "old" ? "working" : "completed", revision);
  }, "old", {
    waitMs: 1_000,
    pollMs: 750,
    subscribe: (callback) => {
      wake = callback;
      return () => { closed = true; };
    },
  });
  setTimeout(() => {
    revision = "new";
    wake?.();
  }, 30);
  const result = await completed;
  assert.equal(result.view.status, "completed");
  assert.equal(result.unchanged, false);
  assert.equal(closed, true);
  assert.ok(Date.now() - startedAt < 500, "event should beat a 750ms poll");
  assert.ok(reads <= 3);
});

test("missing file events fall back to bounded growing safety intervals", async () => {
  let reads = 0;
  let closed = false;
  const result = await waitForTaskChange(async () => {
    reads++;
    return view("working", "unchanged");
  }, "unchanged", {
    waitMs: 420,
    pollMs: 35,
    subscribe: () => () => { closed = true; },
  });
  assert.equal(result.unchanged, true);
  assert.equal(closed, true);
  assert.ok(reads >= 2 && reads < 11, `unexpected polling frequency: ${reads}`);
});
