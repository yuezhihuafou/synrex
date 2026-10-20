import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import { MultiNodeRouter, type NodeTransport } from "./router.js";
import { withMultiNodeRouting } from "./mcp-routing.js";
import { SqliteControlPlaneStore } from "./store.js";

test("MCP routing sends selected workspace to a remote node and keeps later tools sticky", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-routing-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "local",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/local"] },
  });
  const remote = store.registerRemoteNode({
    id: "node_remote",
    alias: "gpu",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: { gpu: "true" }, workspaceRoots: ["/remote"] },
  });
  const calls: Array<{ nodeId: string; name: string; args: Record<string, unknown> }> = [];
  const transport: NodeTransport = {
    async call(nodeId, call) {
      calls.push({ nodeId, name: call.name, args: call.arguments });
      if (call.name === "open_workspace") {
        return {
          content: [{ type: "text", text: "Opened workspace ws_remote." }],
          structuredContent: { workspaceId: "ws_remote", root: "/remote/repo" },
        };
      }
      if (call.name === "exec_command") {
        return {
          content: [{ type: "text", text: "task=task_local working" }],
          structuredContent: { taskId: "task_local", runId: "run_local", running: true },
        };
      }
      if (call.name === "task_get" || call.name === "task_wait") {
        return {
          content: [{ type: "text", text: `task=${String(call.arguments.taskId)} completed` }],
          structuredContent: { taskId: call.arguments.taskId, status: "completed", runId: "run_local" },
        };
      }
      return { structuredContent: { result: "remote-read" } };
    },
  };
  const router = new MultiNodeRouter(store, transport, local.id);
  const handlers = new Map<string, (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown>();
  const target: McpRegistrationTarget = {
    registerTool: ((name: string, _def: unknown, handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler);
      return {};
    }) as McpRegistrationTarget["registerTool"],
    registerResource: (() => ({})) as unknown as McpRegistrationTarget["registerResource"],
  };
  const routed = withMultiNodeRouting(target, { router, store, localNodeId: local.id });
  (routed.registerTool as unknown as (name: string, def: unknown, handler: typeof handlers extends Map<string, infer H> ? H : never) => unknown)(
    "open_workspace",
    {},
    async () => ({ structuredContent: { workspaceId: "ws_local" } }),
  );
  (routed.registerTool as unknown as (name: string, def: unknown, handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown) => unknown)(
    "read",
    {},
    async () => ({ structuredContent: { result: "local-read" } }),
  );
  for (const name of ["exec_command", "task_get", "task_wait"]) {
    (routed.registerTool as unknown as (name: string, def: unknown, handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown) => unknown)(
      name,
      {},
      async () => ({ structuredContent: { result: "local" } }),
    );
  }

  const opened = await handlers.get("open_workspace")!({ path: "/remote/repo", node: "gpu" }, {} as Record<string, unknown>) as Record<string, unknown>;
  const workspaceId = (opened.structuredContent as Record<string, unknown>).workspaceId as string;
  assert.notEqual(workspaceId, "ws_remote");
  const read = await handlers.get("read")!({ workspaceId, path: "README.md" }, {}) as Record<string, unknown>;
  assert.equal((read.structuredContent as Record<string, unknown>).result, "remote-read");
  assert.deepEqual(calls.map((call) => [call.nodeId, call.name]), [
    [remote.id, "open_workspace"],
    [remote.id, "read"],
  ]);
  assert.equal(calls[1]?.args.workspaceId, "ws_remote");

  const started = await handlers.get("exec_command")!({ workspaceId, cmd: "sleep 5" }, {}) as Record<string, unknown>;
  const globalTaskId = (started.structuredContent as Record<string, unknown>).taskId as string;
  assert.match(globalTaskId, /^task_[0-9a-f]{32}$/);
  assert.notEqual(globalTaskId, "task_local");
  const task = await handlers.get("task_get")!({ workspaceId, taskId: globalTaskId }, {}) as Record<string, unknown>;
  assert.equal((task.structuredContent as Record<string, unknown>).taskId, globalTaskId);
  assert.equal(calls.at(-1)?.args.taskId, "task_local");
  const waited = await handlers.get("task_wait")!({ workspaceId, taskId: globalTaskId, sinceRevision: "prior" }, {}) as Record<string, unknown>;
  assert.equal((waited.structuredContent as Record<string, unknown>).taskId, globalTaskId);
  assert.equal(calls.at(-1)?.args.taskId, "task_local");
  assert.equal(calls.at(-1)?.args.sinceRevision, "prior");

  const compatTask = await handlers.get("exec_command")!(
    { workspaceId, cmd: `devspace-task get ${globalTaskId}` },
    {},
  ) as Record<string, unknown>;
  assert.equal((compatTask.structuredContent as Record<string, unknown>).taskId, globalTaskId);
  assert.equal(calls.at(-1)?.args.cmd, "devspace-task get task_local");

  const replayedStart = await handlers.get("exec_command")!(
    { workspaceId, cmd: "sleep 5" },
    {},
  ) as Record<string, unknown>;
  assert.equal(
    (replayedStart.structuredContent as Record<string, unknown>).taskId,
    globalTaskId,
  );

});


test("migrated coordinator preserves global workspace/task IDs while executing local sessions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-migrated-local-route-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }); });
  const local = store.ensureLocalNode({ alias: "swy1", platform: { os: "linux", arch: "x64" }, capabilities: { toolMode: "codex", features: [], labels: {} } });
  store.bindWorkspace({ workspaceId: "ws_global", nodeId: local.id, localWorkspaceId: "ws_original" });
  const globalTaskId = "task_" + "a".repeat(32);
  store.bindTask({ taskId: globalTaskId, nodeId: local.id, workspaceId: "ws_global", localTaskId: "task_original" });
  const handlers = new Map<string, (i: Record<string, unknown>, e: Record<string, unknown>) => unknown>();
  const target = {
    registerTool: (name: string, _def: unknown, handler: (i: Record<string, unknown>, e: Record<string, unknown>) => unknown) => { handlers.set(name, handler); return {}; },
    registerResource: () => ({}),
  } as unknown as McpRegistrationTarget;
  const transport: NodeTransport = { async call() { throw new Error("Local route must not dispatch to a worker"); } };
  const routed = withMultiNodeRouting(target, { router: new MultiNodeRouter(store, transport, local.id), store, localNodeId: local.id });
  const inputs: Record<string, unknown>[] = [];
  for (const name of ["read", "task_get", "task_wait", "exec_command"]) {
    (routed.registerTool as unknown as (n: string, d: unknown, h: (i: Record<string, unknown>) => unknown) => unknown)(name, {}, (input) => {
      inputs.push(input);
      return { structuredContent: { workspaceId: input.workspaceId, ...(name === "read" ? {} : { taskId: "task_original" }) }, content: [{ type: "text", text: "workspace ws_original" }] };
    });
  }
  const read = await handlers.get("read")!({ workspaceId: "ws_global", path: "AGENTS.md" }, {}) as { structuredContent: { workspaceId: string } };
  assert.equal(inputs.at(-1)?.workspaceId, "ws_original"); assert.equal(read.structuredContent.workspaceId, "ws_global");
  const task = await handlers.get("task_get")!({ workspaceId: "ws_global", taskId: globalTaskId }, {}) as { structuredContent: { taskId: string } };
  assert.equal(inputs.at(-1)?.taskId, "task_original"); assert.equal(task.structuredContent.taskId, globalTaskId);
  const waited = await handlers.get("task_wait")!({ workspaceId: "ws_global", taskId: globalTaskId }, {}) as { structuredContent: { taskId: string } };
  assert.equal(inputs.at(-1)?.taskId, "task_original"); assert.equal(waited.structuredContent.taskId, globalTaskId);
  await handlers.get("exec_command")!({ workspaceId: "ws_global", cmd: `devspace-task get ${globalTaskId}` }, {});
  assert.equal(inputs.at(-1)?.cmd, "devspace-task get task_original");
  assert.equal(store.resolveTask(globalTaskId)?.localTaskId, "task_original");
  store.bindWorkspace({ workspaceId: "ws_other", nodeId: local.id, localWorkspaceId: "ws_other_local" });
  await assert.rejects(async () => handlers.get("task_get")!({ workspaceId: "ws_other", taskId: globalTaskId }, {}), /does not belong/);
});
