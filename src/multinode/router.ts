import { randomBytes } from "node:crypto";
import type { ControlPlaneStore, WorkspaceRoute } from "./store.js";
import { assertNodeProtocolCompatible } from "./protocol.js";

export interface NodeToolCall {
  name: string;
  arguments: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export type NodeToolResult = Record<string, unknown>;

export interface NodeTransport {
  call(nodeId: string, input: NodeToolCall): Promise<NodeToolResult>;
}

export interface OpenWorkspaceRouteInput {
  node?: string;
  arguments: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/**
 * Host-facing multi-node routing stays above the existing node runtime. The
 * runtime remains authoritative for filesystem/process/LSP/Normify semantics;
 * the router only selects a node, rewrites opaque workspace identity, and
 * forwards the existing tool contract.
 */
export class MultiNodeRouter {
  constructor(
    private readonly store: ControlPlaneStore,
    private readonly transport: NodeTransport,
    private readonly defaultNodeId: string,
    private readonly onMetric?: (event: string, fields: Record<string, string | number | boolean>) => void,
  ) {}

  private async timedCall(nodeId: string, call: NodeToolCall): Promise<NodeToolResult> {
    const startedAt = performance.now();
    let success = false;
    try {
      const result = await this.transport.call(nodeId, call);
      success = true;
      return result;
    } finally {
      this.onMetric?.("node_dispatch", {
        nodeId,
        tool: call.name,
        elapsedMs: Math.round(performance.now() - startedAt),
        success,
      });
    }
  }

  async openWorkspace(input: OpenWorkspaceRouteInput): Promise<NodeToolResult> {
    const node = input.node
      ? this.store.findNode(input.node)
      : this.store.getNode(this.defaultNodeId);
    if (!node) throw new Error(`Unknown execution node: ${input.node ?? this.defaultNodeId}`);
    if (node.health === "offline" || node.health === "draining") {
      throw new Error(`Execution node ${node.alias ?? node.id} is ${node.health}.`);
    }
    assertNodeProtocolCompatible(node);
    assertNodeToolContract(node, "open_workspace");

    const result = await this.timedCall(node.id, {
      name: "open_workspace",
      arguments: input.arguments,
      meta: input.meta,
    });
    const localWorkspaceId = readWorkspaceId(result);
    const existing = this.store.findWorkspaceByLocal(node.id, localWorkspaceId);
    const workspaceId = existing?.workspaceId ?? createGlobalWorkspaceId();
    if (!existing) this.store.bindWorkspace({ workspaceId, nodeId: node.id, localWorkspaceId });
    let rewritten = rewriteOpaqueId(result, localWorkspaceId, workspaceId);
    // A fresh GPT conversation needs routable IDs for tasks that are still
    // running, not just unacknowledged terminal notifications. Both lists are
    // owner-verified by the peer's open_workspace implementation.
    for (const localTaskId of readRecoverableTaskIds(result)) {
      const existingTask = this.store.findTaskByLocal(node.id, localTaskId);
      const taskId = existingTask?.taskId ?? createGlobalTaskId();
      if (!existingTask) {
        this.store.bindTask({
          taskId,
          nodeId: node.id,
          workspaceId,
          localTaskId,
        });
      }
      rewritten = rewriteOpaqueId(rewritten, localTaskId, taskId);
    }
    return rewritten;
  }

  async callWorkspaceTool(input: NodeToolCall & { workspaceId: string }): Promise<NodeToolResult> {
    const route = this.requireWorkspace(input.workspaceId);
    const node = this.store.getNode(route.nodeId);
    if (!node) throw new Error(`Workspace ${input.workspaceId} references unknown node ${route.nodeId}.`);
    if (node.health === "offline") {
      throw new Error(`Workspace ${input.workspaceId} is temporarily unavailable because node ${node.alias ?? node.id} is offline.`);
    }
    assertNodeProtocolCompatible(node);
    assertNodeToolContract(node, input.name);
    const result = await this.timedCall(node.id, {
      name: input.name,
      arguments: { ...input.arguments, workspaceId: route.localWorkspaceId },
      meta: input.meta,
    });
    return rewriteOpaqueId(result, route.localWorkspaceId, input.workspaceId);
  }

  requireWorkspace(workspaceId: string): WorkspaceRoute {
    const route = this.store.resolveWorkspace(workspaceId);
    if (!route) throw new Error(`Unknown workspaceId: ${workspaceId}`);
    return route;
  }
}

/** Only enforce tool revisions actually advertised by a peer. */
export function assertNodeToolContract(
  node: Pick<import("./protocol.js").ExecutionNode, "id" | "capabilities">,
  toolName: string,
): void {
  const manifest = node.capabilities.toolContracts;
  if (!manifest) return; // Legacy nodes remain readable during migration.
  const version = manifest[toolName];
  if (version !== 1) {
    throw new Error(
      "Node " + node.id + " cannot execute " + toolName
      + ": required tool contract v1 is "
      + (version === undefined ? "not advertised" : "incompatible with v" + version) + ".",
    );
  }
}

function createGlobalWorkspaceId(): string {
  return `ws_${randomBytes(10).toString("hex")}`;
}

function createGlobalTaskId(): string {
  return `task_${randomBytes(16).toString("hex")}`;
}

function readWorkspaceId(result: NodeToolResult): string {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("Node open_workspace response is missing structuredContent.");
  }
  const workspaceId = (structured as Record<string, unknown>).workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error("Node open_workspace response is missing workspaceId.");
  }
  return workspaceId;
}

function readRecoverableTaskIds(result: NodeToolResult): string[] {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return [];
  const fields = structured as Record<string, unknown>;
  const ids = new Set<string>();
  for (const key of ["pendingTasks", "activeTasks"]) {
    const items = fields[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const taskId = (item as Record<string, unknown>).taskId;
      if (typeof taskId === "string" && /^task_(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(taskId)) ids.add(taskId);
    }
  }
  return [...ids];
}

function rewriteOpaqueId<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.replaceAll(from, to) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteOpaqueId(item, from, to)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, rewriteOpaqueId(nested, from, to)]),
  ) as T;
}
