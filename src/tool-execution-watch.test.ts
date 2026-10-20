import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { watchToolExecution, type ToolExecutionEvent } from "./tool-execution-watch.js";

test("fast tool completes without a spurious stall warning", async () => {
  const events: ToolExecutionEvent[] = [];
  const watch = watchToolExecution({
    tool: "read", requestId: "request-1", warnAfterMs: 20,
    emit: (_level, event) => events.push(event),
  });
  watch.finish("ok");
  watch.finish("error");
  await sleep(40);
  assert.deepEqual(events, ["tool_execution_started", "tool_execution_finished"]);
});

test("stalled tool emits warnings, then records eventual completion", async () => {
  const events: Array<{ event: ToolExecutionEvent; fields: Record<string, unknown> }> = [];
  const watch = watchToolExecution({
    tool: "apply_patch", workspaceId: "ws_1", requestId: "request-2",
    warnAfterMs: 10, repeatAfterMs: 20,
    emit: (_level, event, fields) => events.push({ event, fields }),
  });
  await sleep(50);
  watch.finish("error");
  assert.equal(events[0]?.event, "tool_execution_started");
  const stall = events.find((item) => item.event === "tool_execution_stalled");
  assert.ok(stall);
  assert.equal(stall.fields.requestId, "request-2");
  assert.equal(stall.fields.tool, "apply_patch");
  assert.equal(events.at(-1)?.event, "tool_execution_finished");
  assert.equal(events.at(-1)?.fields.outcome, "error");
  assert.equal(events.at(-1)?.fields.stalled, true);
});
