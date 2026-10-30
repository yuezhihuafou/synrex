import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceOperationGate } from "./workspace-operation-gate.js";

const pause = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

test("parallel reads, writer waits, and later readers cannot overtake writer", async () => {
  const gate = new WorkspaceOperationGate();
  const hold = pause();
  const order: string[] = [];
  const first = gate.run("/same/checkout", "read", async () => { order.push("read1"); await hold.promise; });
  const second = gate.run("/same/checkout", "read", async () => { order.push("read2"); await hold.promise; });
  const writer = gate.run("/same/checkout", "write", async () => { order.push("write"); });
  const later = gate.run("/same/checkout", "read", async () => { order.push("read3"); });
  const independent = gate.run("/other/checkout", "write", async () => { order.push("other"); });
  await independent;
  assert.ok(order.includes("other"));
  hold.release();
  await Promise.all([first, second, writer, later]);
  assert.ok(order.indexOf("write") > order.indexOf("read1"));
  assert.ok(order.indexOf("write") > order.indexOf("read2"));
  assert.ok(order.indexOf("read3") > order.indexOf("write"));
  assert.equal(gate.queuedRoots, 0);
});

test("failed write leaves later work unblocked", async () => {
  const gate = new WorkspaceOperationGate();
  const first = gate.run("root", "write", async () => { throw Error("failed"); });
  const second = gate.run("root", "write", async () => "recovered");
  await assert.rejects(first, /failed/);
  assert.equal(await second, "recovered");
  assert.equal(gate.queuedRoots, 0);
});

test("64 parallel writes serialize per physical checkout, not per conversation", async () => {
  const gate = new WorkspaceOperationGate();
  let active = 0, maxActive = 0, completed = 0;
  const jobs = Array.from({length:64}, (_,i) => gate.run("/same/check-out", "write", async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    completed++;
    active--;
    return i;
  }));
  assert.deepEqual(await Promise.all(jobs), Array.from({length:64},(_,i)=>i));
  assert.equal(maxActive,1);
  assert.equal(completed,64);
  assert.equal(gate.queuedRoots,0);
});
