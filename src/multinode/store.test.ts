import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteControlPlaneStore } from "./store.js";

function registration(alias?: string) {
  return {
    alias,
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex" as const, features: ["workspace.checkout"], labels: {} },
  };
}

test("local node identity is stable across store reopen", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-node-store-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const firstStore = new SqliteControlPlaneStore(stateDir);
  const first = firstStore.ensureLocalNode(registration("primary"));
  firstStore.close();

  const secondStore = new SqliteControlPlaneStore(stateDir);
  t.after(() => secondStore.close());
  const second = secondStore.ensureLocalNode(registration("renamed"));
  assert.equal(second.id, first.id);
  assert.equal(second.alias, "renamed");
});

test("workspace and task routes retain node affinity", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-route-store-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const node = store.ensureLocalNode(registration());
  store.bindWorkspace({ workspaceId: "ws_global", nodeId: node.id, localWorkspaceId: "ws_local" });
  assert.deepEqual(store.resolveWorkspace("ws_global")?.nodeId, node.id);
  store.bindTask({
    taskId: "task_global",
    nodeId: node.id,
    workspaceId: "ws_global",
    localTaskId: "task_local",
    runId: "run_local",
  });
  assert.equal(store.resolveTask("task_global")?.localTaskId, "task_local");
});
