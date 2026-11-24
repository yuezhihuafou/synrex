import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { McpMountManager } from "./mcp-mount-manager.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export function registerMcpMountTools(
  server: McpRegistrationTarget,
  manager: McpMountManager,
  workspaces: WorkspaceRegistry,
): void {
  server.registerTool(
    "mcp_mount",
    {
      description: "List MCP mounts, discover remote tools, or invoke one via JSON request.",
      inputSchema: {
        workspaceId: z.string().trim().min(1),
        request: z.string().max(65_536).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ workspaceId, request }, extra) => {
      await workspaces.getWorkspace(workspaceId);
      let input: Record<string, unknown> = {};
      if (request) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(request);
        } catch {
          throw new Error("mcp_mount request must be valid JSON.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("mcp_mount request must be a JSON object.");
        }
        input = parsed as Record<string, unknown>;
      }
      const unknownKeys = Object.keys(input).filter((key) => !["server", "tool", "arguments"].includes(key));
      if (unknownKeys.length > 0) throw new Error(`Unsupported mcp_mount request fields: ${unknownKeys.join(", ")}.`);
      const serverName = typeof input.server === "string" ? input.server : undefined;
      const toolName = typeof input.tool === "string" ? input.tool : undefined;
      const hasArguments = Object.prototype.hasOwnProperty.call(input, "arguments");
      if (hasArguments && (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments))) {
        throw new Error("mcp_mount request.arguments must be a JSON object.");
      }
      const toolArguments = hasArguments ? input.arguments as Record<string, unknown> : {};
      if (!serverName && !toolName) {
        if (Object.keys(input).length > 0) {
          throw new Error("Do not supply arguments when listing MCP mounts.");
        }
        const servers = manager.listServers();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(servers) }],
          structuredContent: { action: "servers", workspaceId, servers },
        };
      }
      if (!serverName || !toolName) {
        if (serverName && !toolName && Object.keys(input).length === 1) {
          const tools = await manager.listTools(serverName, requestSignal(extra));
          return {
            content: [{ type: "text" as const, text: JSON.stringify(tools) }],
            structuredContent: { action: "tools", workspaceId, server: serverName, tools },
          };
        }
        throw new Error("Use mcp_mount without request to list mounts, or pass request as JSON: {server}, or {server, tool, arguments}.");
      }
      return manager.callTool(serverName, toolName, toolArguments, requestSignal(extra));
    },
  );
}

function requestSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
