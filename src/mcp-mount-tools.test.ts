import assert from "node:assert/strict";
import test from "node:test";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { McpMountManager } from "./mcp-mount-manager.js";
import { registerMcpMountTools } from "./mcp-mount-tools.js";
import type { WorkspaceRegistry } from "./workspaces.js";

type Handler = (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;

test("mcp_mount lists mounts, discovers schemas, invokes remote tools, and enforces workspace ownership", async () => {
  const handlers = new Map<string, Handler>();
  const definitionByName = new Map<string, Record<string, unknown>>();
  const target: McpRegistrationTarget = {
    registerTool: ((name: string, definition: Record<string, unknown>, handler: Handler) => {
      handlers.set(name, handler);
      definitionByName.set(name, definition);
      return {};
    }) as McpRegistrationTarget["registerTool"],
    registerResource: (() => ({})) as unknown as McpRegistrationTarget["registerResource"],
  };

  const workspaceCalls: string[] = [];
  const workspaces = {
    async getWorkspace(workspaceId: string) {
      workspaceCalls.push(workspaceId);
      if (workspaceId !== "ws_gateway") throw new Error("Unknown workspace or workspace is not owned by this node.");
      return { root: "/workspace" };
    },
  } as unknown as WorkspaceRegistry;

  const controller = new AbortController();
  const managerCalls: Array<{ kind: string; args: unknown[] }> = [];
  const manager = {
    listServers() {
      managerCalls.push({ kind: "servers", args: [] });
      return [{ name: "agent-desktop", transport: "stdio", enabled: true, connected: false }];
    },
    async listTools(server: string, signal?: AbortSignal) {
      managerCalls.push({ kind: "tools", args: [server, signal] });
      return [{ name: "desktop_snapshot", description: "Snapshot", inputSchema: { type: "object" } }];
    },
    async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
      managerCalls.push({ kind: "call", args: [server, tool, args, signal] });
      return {
        content: [{ type: "text", text: "desktop snapshot result" }],
        structuredContent: { windowCount: 2 },
      };
    },
  } as unknown as McpMountManager;

  registerMcpMountTools(target, manager, workspaces);
  const handler = handlers.get("mcp_mount");
  assert.ok(handler);

  const servers = await handler({ workspaceId: "ws_gateway" }, {}) as {
    structuredContent: { action: string; servers: Array<{ name: string; connected: boolean }> };
  };
  assert.equal(servers.structuredContent.action, "servers");
  assert.equal(servers.structuredContent.servers[0]?.name, "agent-desktop");
  assert.equal(servers.structuredContent.servers[0]?.connected, false);

  const tools = await handler({ workspaceId: "ws_gateway", request: JSON.stringify({ server: "agent-desktop" }) }, {
    signal: controller.signal,
  }) as { structuredContent: { action: string; tools: Array<{ name: string }> } };
  assert.equal(tools.structuredContent.action, "tools");
  assert.equal(tools.structuredContent.tools[0]?.name, "desktop_snapshot");

  const result = await handler({
    workspaceId: "ws_gateway",
    request: JSON.stringify({ server: "agent-desktop", tool: "desktop_snapshot", arguments: { app: "Finder" } }),
  }, { signal: controller.signal }) as { structuredContent: { windowCount: number } };
  assert.equal(result.structuredContent.windowCount, 2);
  assert.deepEqual(managerCalls[1]?.args, ["agent-desktop", controller.signal]);
  assert.deepEqual(managerCalls[2]?.args, ["agent-desktop", "desktop_snapshot", { app: "Finder" }, controller.signal]);
  assert.deepEqual(workspaceCalls, ["ws_gateway", "ws_gateway", "ws_gateway"]);

  const definition = definitionByName.get("mcp_mount") as { annotations?: Record<string, unknown> };
  assert.equal(definition.annotations?.openWorldHint, true);
  assert.equal(definition.annotations?.destructiveHint, true);

  await assert.rejects(() => handler({
    workspaceId: "ws_other_node", request: JSON.stringify({ server: "agent-desktop", tool: "desktop_snapshot", arguments: {} }),
  }, {}), /not owned by this node/);
});
