import assert from "node:assert/strict";
import test from "node:test";
import { NodeLinkHub } from "./link-hub.js";

test("link hub serves multiple concurrent poll waiters without cancelling them", async () => {
  const hub = new NodeLinkHub(5_000);
  try {
    const polls = [hub.poll("node_a", 200), hub.poll("node_a", 200), hub.poll("node_a", 200)];
    const calls = [0, 1, 2].map(() => hub.call("node_a", { name: "read", arguments: {} }));
    const received = await Promise.all(polls);
    assert.equal(received.filter(Boolean).length, 3);
    assert.equal(new Set(received.map((item) => item?.id)).size, 3);
    for (const request of received) if (request) hub.complete("node_a", request.id, { ok: true });
    assert.deepEqual(await Promise.all(calls), [{ ok: true }, { ok: true }, { ok: true }]);
  } finally {
    hub.close();
  }
});

test("completion retry after a lost acknowledgement remains accepted only for its owner", async () => {
  const hub = new NodeLinkHub(5_000);
  try {
    const result = hub.call("node_a", { name: "read", arguments: {} });
    const request = await hub.poll("node_a", 100);
    assert.ok(request);
    assert.equal(hub.complete("node_a", request.id, { ok: true }), true);
    assert.deepEqual(await result, { ok: true });
    assert.equal(hub.complete("node_a", request.id, { ok: false }), true);
    assert.throws(() => hub.complete("node_b", request.id, {}), /does not belong/);
    assert.throws(() => hub.fail("node_b", request.id, "wrong owner"), /does not belong/);
  } finally {
    hub.close();
  }
});

test("failed completion can be acknowledged again without rejecting another caller", async () => {
  const hub = new NodeLinkHub(5_000);
  try {
    const result = hub.call("node_a", { name: "read", arguments: {} });
    const rejection = assert.rejects(result, /original failure/);
    const request = await hub.poll("node_a", 100);
    assert.ok(request);
    assert.equal(hub.fail("node_a", request.id, "original failure"), true);
    await rejection;
    assert.equal(hub.fail("node_a", request.id, "retry"), true);
  } finally {
    hub.close();
  }
});

test("link hub dispatches a tool call to the polling node and resolves completion", async () => {
  const hub = new NodeLinkHub(5_000);
  try {
    const resultPromise = hub.call("node_a", {
      name: "read",
      arguments: { workspaceId: "ws_local", path: "README.md" },
    });
    const request = await hub.poll("node_a", 100);
    assert.ok(request);
    assert.equal(request.call.name, "read");
    hub.complete("node_a", request.id, { structuredContent: { result: "ok" } });
    assert.deepEqual(await resultPromise, { structuredContent: { result: "ok" } });
  } finally {
    hub.close();
  }
});

test("link hub does not let another node complete a delivered request", async () => {
  const hub = new NodeLinkHub(5_000);
  try {
    const resultPromise = hub.call("node_a", { name: "read", arguments: {} });
    const request = await hub.poll("node_a", 100);
    assert.ok(request);
    assert.throws(() => hub.complete("node_b", request.id, {}), /does not belong/);
    hub.complete("node_a", request.id, { ok: true });
    assert.deepEqual(await resultPromise, { ok: true });
  } finally {
    hub.close();
  }
});

test("link hub refuses to acknowledge an unknown completion", () => {
  const hub = new NodeLinkHub(5_000);
  try {
    assert.equal(
      hub.complete("node_a", "nrq_missing", { structuredContent: { result: "late" } }),
      false,
    );
    assert.equal(hub.fail("node_a", "nrq_missing", "late failure"), false);
  } finally {
    hub.close();
  }
});

test("link hub redelivers an uncompleted request after its delivery lease", async () => {
  const hub = new NodeLinkHub(5_000, 10);
  try {
    const resultPromise = hub.call("node_a", {
      name: "exec_command",
      arguments: { workspaceId: "ws_local", cmd: "sleep 5" },
    });
    const first = await hub.poll("node_a", 100);
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const redelivered = await hub.poll("node_a", 100);
    assert.ok(redelivered);
    assert.equal(redelivered.id, first.id);
    hub.complete("node_a", first.id, { structuredContent: { taskId: "task_local" } });
    assert.deepEqual(await resultPromise, { structuredContent: { taskId: "task_local" } });
  } finally {
    hub.close();
  }
});

test("separate identical invocations receive distinct request ids", async () => {
  const call = {
    name: "exec_command",
    arguments: { workspaceId: "ws_local", cmd: "side-effect" },
  };
  const hub = new NodeLinkHub(5_000, 10);
  try {
    const firstPromise = hub.call("node_a", call);
    const secondPromise = hub.call("node_a", call);
    const first = await hub.poll("node_a", 100);
    const second = await hub.poll("node_a", 100);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    hub.complete("node_a", first.id, { structuredContent: { result: "first" } });
    hub.complete("node_a", second.id, { structuredContent: { result: "second" } });
    assert.deepEqual(await firstPromise, { structuredContent: { result: "first" } });
    assert.deepEqual(await secondPromise, { structuredContent: { result: "second" } });
  } finally {
    hub.close();
  }
});

test("delivered request timeout is explicitly indeterminate, and late completion is logged", async () => {
  const events: Array<{ event: string; outcome: string }> = [];
  const hub = new NodeLinkHub(20, 10, (event, fields) => { if (typeof fields.outcome === "string") events.push({ event, outcome: fields.outcome }); });
  try {
    const call = hub.call("node_a", { name: "apply_patch", arguments: {} });
    const sent = await hub.poll("node_a", 1);
    assert.ok(sent);
    const rejection = assert.rejects(call, /indeterminate_after_dispatch.*may still be running/);
    // Hub timers are intentionally unref'd. Keep this isolated test alive.
    await new Promise((resolve) => setTimeout(resolve, 35));
    await rejection;
    assert.equal(hub.complete("node_a", sent.id, { ok: true }), true);
    assert.deepEqual(events, [
      { event: "node_request_timeout", outcome: "indeterminate_after_dispatch" },
      { event: "node_late_completion", outcome: "completed_after_host_timeout" },
    ]);
  } finally { hub.close(); }
});

test("timeout before dispatch is never classified as an executed mutation", async () => {
  const events: string[] = [];
  const hub = new NodeLinkHub(20, 10, (_event, fields) => { if (typeof fields.outcome === "string") events.push(fields.outcome); });
  try {
    const call = hub.call("node_absent", { name: "apply_patch", arguments: {} });
    const rejection = assert.rejects(call, /not_dispatched/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await rejection;
    assert.deepEqual(events, ["not_dispatched"]);
  } finally { hub.close(); }
});

test("a failing observability callback cannot strand a timed-out RPC", async () => {
  const hub = new NodeLinkHub(20, 10, () => { throw new Error("diagnostic output failed"); });
  try {
    const call = hub.call("offline", { name: "read", arguments: {} });
    const rejected = assert.rejects(call, /not_dispatched/);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await rejected;
  } finally { hub.close(); }
});
