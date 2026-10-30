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

test("draining and offline gateway never reroute or replay new work; existing reads still work", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synrex-peer-drain-"));
  const store = new SqliteControlPlaneStore(dir);
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  const owner = store.ensureLocalNode({alias:"swy1",platform:{os:"linux",arch:"x64"},
    capabilities:{toolMode:"codex",features:[],labels:{}}});
  const peer = store.registerRemoteNode({id:"node_gateway_draining",alias:"gateway",
    platform:{os:"linux",arch:"x64"},capabilities:{toolMode:"codex",features:[],labels:{}}});
  const transport = new FakeTransport();
  const router = new MultiNodeRouter(store, transport, owner.id);
  const opened = await router.openWorkspace({node:peer.id, arguments:{path:"/gateway/project"}});
  const workspaceId = (opened.structuredContent as {workspaceId:string}).workspaceId;
  store.setNodeHealth(peer.id, "draining");
  const read = await router.callWorkspaceTool({workspaceId,name:"read",arguments:{path:"README.md"}});
  assert.equal((read.structuredContent as {ok:boolean}).ok, true);
  await assert.rejects(()=>router.callWorkspaceTool({workspaceId,name:"exec_command",
    arguments:{cmd:"touch unsafe"}}), /draining/);
  assert.equal(transport.calls.filter(c=>c.input.name==="exec_command").length,0);
  store.setNodeHealth(peer.id,"offline");
  await assert.rejects(()=>router.callWorkspaceTool({workspaceId,name:"read",arguments:{path:"README.md"}}),
    /remains pinned.*offline/);
  assert.equal(transport.calls.filter(c=>c.input.name==="read").length,1);
});

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

test("remote workspace recovery maps active task handles and retains their global identities", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "synrex-active-task-route-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }); });
  const local = store.ensureLocalNode({
    alias: "local", platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const remote = store.registerRemoteNode({
    id: "node_recovery", alias: "remote", platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const localTaskId = "task_aaaaaaaaaaaaaaaa";
  const transport: NodeTransport = {
    async call(_node, input) {
      if (input.name === "open_workspace") return {
        content: [{ type: "text", text: `Active task ${localTaskId}` }],
        structuredContent: {
          workspaceId: "ws_remote", root: "/repo", activeTaskCount: 1,
          activeTasks: [{ taskId: localTaskId, status: "working" }],
        },
      };
      return { structuredContent: { result: "working", taskId: input.arguments.taskId } };
    },
  };
  const router = new MultiNodeRouter(store, transport, local.id);
  const first = await router.openWorkspace({ node: remote.id, arguments: { path: "/repo" } });
  const fields = first.structuredContent as { workspaceId: string; activeTasks: Array<{ taskId: string }> };
  const globalId = fields.activeTasks[0]!.taskId;
  assert.match(globalId, /^task_[a-f0-9]{32}$/);
  assert.notEqual(globalId, localTaskId);
  assert.equal(store.resolveTask(globalId)?.localTaskId, localTaskId);
  assert.match(JSON.stringify(first.content), new RegExp(globalId));
  const recovered = await router.openWorkspace({ node: remote.id, arguments: { path: "/repo" } });
  assert.equal((recovered.structuredContent as typeof fields).activeTasks[0]?.taskId, globalId);
  const inspected = await router.callWorkspaceTool({
    workspaceId: fields.workspaceId, name: "task_get", arguments: { taskId: localTaskId },
  });
  assert.equal((inspected.structuredContent as Record<string, unknown>).taskId, localTaskId);
});

test("lost acknowledgment of a remote write is not retried, and reconnect recovers its task identity", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "synrex-remote-lost-ack-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }); });
  const local = store.ensureLocalNode({
    alias: "swy1", platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  const remote = store.registerRemoteNode({
    id: "node_remote_lost_ack", alias: "gateway",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {} },
  });
  let effects = 0;
  let calls = 0;
  const localTaskId = "task_abcdefabcdefabcd";
  const transport: NodeTransport = {
    async call(_nodeId, call) {
      calls++;
      if (call.name === "open_workspace") return {
        content: [{ type: "text", text: "resumed remote project" }],
        structuredContent: {
          workspaceId: "ws_remote_stable", root: "/gateway/project",
          pendingTasks: effects > 0 ? [{ taskId: localTaskId, status: "completed" }] : [],
        },
      };
      if (call.name === "exec_command") {
        effects++;
        throw new Error("simulated: remote command committed but reply disconnected");
      }
      if (call.name === "task_get") return {
        structuredContent: { taskId: localTaskId, status: "completed", exitCode: 0 },
      };
      throw new Error("unexpected transport operation");
    },
  };
  const router = new MultiNodeRouter(store, transport, local.id);
  const opened = await router.openWorkspace({ node: remote.id, arguments: { path: "/gateway/project" } });
  const globalWorkspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  await assert.rejects(() => router.callWorkspaceTool({
    workspaceId: globalWorkspaceId,
    name: "exec_command",
    arguments: { workspaceId: globalWorkspaceId, cmd: "append-once" },
  }), /reply disconnected/);
  assert.equal(effects, 1, "a lost response must not implicitly replay a non-idempotent operation");
  const recovered = await router.openWorkspace({ node: remote.id, arguments: { path: "/gateway/project" } });
  const fields = recovered.structuredContent as {
    workspaceId: string; pendingTasks: Array<{ taskId: string }>;
  };
  assert.equal(fields.workspaceId, globalWorkspaceId);
  const globalTaskId = fields.pendingTasks[0]?.taskId;
  assert.ok(globalTaskId && globalTaskId !== localTaskId);
  const reopened = await router.openWorkspace({ node: remote.id, arguments: { path: "/gateway/project" } });
  assert.equal((reopened.structuredContent as typeof fields).pendingTasks[0]?.taskId, globalTaskId);
  assert.equal(store.resolveTask(globalTaskId)?.localTaskId, localTaskId);
  const receipt = await router.callWorkspaceTool({
    workspaceId: globalWorkspaceId,
    name: "task_get",
    arguments: { workspaceId: globalWorkspaceId, taskId: localTaskId },
  });
  assert.equal((receipt.structuredContent as { status: string }).status, "completed");
  assert.equal(effects, 1);
  assert.equal(calls, 5);
});
