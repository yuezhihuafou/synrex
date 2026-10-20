import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeHealthMonitor } from "./health.js";
import { SqliteControlPlaneStore } from "./store.js";

test("remote node health degrades without changing draining nodes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-health-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const node = store.registerRemoteNode({
    id: "node_remote",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const monitor = new NodeHealthMonitor(store, 100, 200);
  monitor.reconcile(Date.parse(node.lastSeenAt) + 150);
  assert.equal(store.getNode(node.id)?.health, "suspect");
  monitor.reconcile(Date.parse(node.lastSeenAt) + 250);
  assert.equal(store.getNode(node.id)?.health, "offline");
  store.setNodeHealth(node.id, "draining");
  monitor.reconcile(Date.parse(node.lastSeenAt) + 1_000);
  assert.equal(store.getNode(node.id)?.health, "draining");
});
