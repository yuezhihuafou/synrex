import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MultiNodeRouter, type NodeToolCall, type NodeToolResult, type NodeTransport } from "./router.js";
import { SqliteControlPlaneStore } from "./store.js";

class FakeTransport implements NodeTransport {
  calls: Array<{ nodeId: string; input: NodeToolCall }> = [];
  async call(nodeId: string, input: NodeToolCall): Promise<NodeToolResult> {
    this.calls.push({ nodeId, input });
    if (input.name === "open_workspace") {
      return {
        content: [{ type: "text", text: "Opened workspace ws_local." }],
        structuredContent: { workspaceId: "ws_local", root: "/repo" },
      };
    }
    return { structuredContent: { workspaceId: input.arguments.workspaceId, ok: true } };
  }
}

test("router keeps host schema stable and rewrites only workspace identity", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-router-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const node = store.ensureLocalNode({
    alias: "primary",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: ["workspace.checkout"], labels: {} },
  });
  const transport = new FakeTransport();
  const router = new MultiNodeRouter(store, transport, node.id);

  const opened = await router.openWorkspace({ node: "primary", arguments: { path: "/repo" } });
  const globalWorkspaceId = (opened.structuredContent as Record<string, unknown>).workspaceId as string;
  assert.match(globalWorkspaceId, /^ws_[0-9a-f]{20}$/);
  assert.notEqual(globalWorkspaceId, "ws_local");
  assert.equal((opened.content as Array<{ text: string }>)[0]?.text, `Opened workspace ${globalWorkspaceId}.`);

  await router.callWorkspaceTool({
    workspaceId: globalWorkspaceId,
    name: "read",
    arguments: { workspaceId: globalWorkspaceId, path: "README.md" },
  });
  assert.equal(transport.calls[1]?.nodeId, node.id);
  assert.equal(transport.calls[1]?.input.arguments.workspaceId, "ws_local");
});

test("remote workspace recovery binds pending local tasks to stable global task routes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-router-pending-task-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "local",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const remote = store.registerRemoteNode({
    id: "node_remote_pending",
    alias: "remote",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const localTaskId = "task_aaaaaaaaaaaaaaaa";
  const transport: NodeTransport = {
    async call() {
      return {
        content: [{ type: "text", text: `Pending task ${localTaskId}.` }],
        structuredContent: {
          workspaceId: "ws_remote_pending",
          root: "/repo",
          pendingTasks: [{ taskId: localTaskId, status: "completed" }],
          pendingTaskCount: 1,
        },
      };
    },
  };
  const router = new MultiNodeRouter(store, transport, local.id);
  const opened = await router.openWorkspace({ node: remote.id, arguments: { path: "/repo" } });
  const structured = opened.structuredContent as {
    workspaceId: string;
    pendingTasks: Array<{ taskId: string }>;
  };
  const globalTaskId = structured.pendingTasks[0]?.taskId;
  assert.ok(globalTaskId);
  assert.match(globalTaskId, /^task_[0-9a-f]{32}$/);
  assert.notEqual(globalTaskId, localTaskId);
  const route = store.resolveTask(globalTaskId);
  assert.equal(route?.nodeId, remote.id);
  assert.equal(route?.workspaceId, structured.workspaceId);
  assert.equal(route?.localTaskId, localTaskId);
  assert.match((opened.content as Array<{ text: string }>)[0]?.text ?? "", new RegExp(globalTaskId));
});
