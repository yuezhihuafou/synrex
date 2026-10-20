import { desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { executionNodes, taskRoutes, workspaceRoutes } from "../db/schema.js";
import {
  createNodeId,
  DEVSPACE_NODE_PROTOCOL,
  type ExecutionNode,
  type NodeCapabilities,
  type NodeHealth,
  type NodePlatform,
  type NodeRegistration,
} from "./protocol.js";

export interface WorkspaceRoute {
  workspaceId: string;
  nodeId: string;
  localWorkspaceId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface TaskRoute {
  taskId: string;
  nodeId: string;
  workspaceId: string;
  localTaskId: string;
  runId?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface ControlPlaneStore {
  ensureLocalNode(input: NodeRegistration): ExecutionNode;
  registerRemoteNode(input: NodeRegistration & { id: string }): ExecutionNode;
  heartbeat(nodeId: string, health?: NodeHealth): ExecutionNode;
  setNodeHealth(nodeId: string, health: NodeHealth): ExecutionNode;
  getNode(nodeId: string): ExecutionNode | undefined;
  findNode(selector: string): ExecutionNode | undefined;
  listNodes(): ExecutionNode[];
  bindWorkspace(input: { workspaceId: string; nodeId: string; localWorkspaceId: string }): WorkspaceRoute;
  resolveWorkspace(workspaceId: string): WorkspaceRoute | undefined;
  findWorkspaceByLocal(nodeId: string, localWorkspaceId: string): WorkspaceRoute | undefined;
  bindTask(input: { taskId: string; nodeId: string; workspaceId: string; localTaskId: string; runId?: string }): TaskRoute;
  resolveTask(taskId: string): TaskRoute | undefined;
  findTaskByLocal(nodeId: string, localTaskId: string): TaskRoute | undefined;
  close?(): void;
}

export class SqliteControlPlaneStore implements ControlPlaneStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  ensureLocalNode(input: NodeRegistration): ExecutionNode {
    const row = this.database.db
      .select()
      .from(executionNodes)
      .where(eq(executionNodes.kind, "local"))
      .orderBy(desc(executionNodes.createdAt))
      .get();
    const now = new Date().toISOString();
    if (row) {
      this.database.db.update(executionNodes).set({
        alias: input.alias ?? null,
        protocolMajor: input.protocol?.major ?? DEVSPACE_NODE_PROTOCOL.major,
        protocolMinor: input.protocol?.minor ?? DEVSPACE_NODE_PROTOCOL.minor,
        health: "online",
        platformJson: JSON.stringify(input.platform),
        capabilitiesJson: JSON.stringify(input.capabilities),
        lastSeenAt: now,
      }).where(eq(executionNodes.id, row.id)).run();
      return this.getNode(row.id)!;
    }

    const id = input.id ?? createNodeId();
    this.database.db.insert(executionNodes).values({
      id,
      kind: "local",
      alias: input.alias ?? null,
      protocolMajor: input.protocol?.major ?? DEVSPACE_NODE_PROTOCOL.major,
      protocolMinor: input.protocol?.minor ?? DEVSPACE_NODE_PROTOCOL.minor,
      health: "online",
      platformJson: JSON.stringify(input.platform),
      capabilitiesJson: JSON.stringify(input.capabilities),
      createdAt: now,
      lastSeenAt: now,
    }).run();
    return this.getNode(id)!;
  }

  registerRemoteNode(input: NodeRegistration & { id: string }): ExecutionNode {
    const now = new Date().toISOString();
    const existing = this.getNode(input.id);
    if (existing?.kind === "local") {
      throw new Error(`Node ${input.id} is the local runtime and cannot be replaced by a remote registration.`);
    }
    this.database.db.insert(executionNodes).values({
      id: input.id,
      kind: "remote",
      alias: input.alias ?? null,
      protocolMajor: input.protocol?.major ?? DEVSPACE_NODE_PROTOCOL.major,
      protocolMinor: input.protocol?.minor ?? DEVSPACE_NODE_PROTOCOL.minor,
      health: "online",
      platformJson: JSON.stringify(input.platform),
      capabilitiesJson: JSON.stringify(input.capabilities),
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    }).onConflictDoUpdate({
      target: executionNodes.id,
      set: {
        alias: input.alias ?? null,
        protocolMajor: input.protocol?.major ?? DEVSPACE_NODE_PROTOCOL.major,
        protocolMinor: input.protocol?.minor ?? DEVSPACE_NODE_PROTOCOL.minor,
        health: "online",
        platformJson: JSON.stringify(input.platform),
        capabilitiesJson: JSON.stringify(input.capabilities),
        lastSeenAt: now,
      },
    }).run();
    return this.getNode(input.id)!;
  }

  heartbeat(nodeId: string, health: NodeHealth = "online"): ExecutionNode {
    const now = new Date().toISOString();
    const current = this.getNode(nodeId);
    if (!current) throw new Error(`Unknown node: ${nodeId}`);
    const nextHealth = current.health === "draining" ? "draining" : health;
    const result = this.database.db.update(executionNodes)
      .set({ health: nextHealth, lastSeenAt: now })
      .where(eq(executionNodes.id, nodeId))
      .run();
    if (result.changes === 0) throw new Error(`Unknown node: ${nodeId}`);
    return this.getNode(nodeId)!;
  }

  setNodeHealth(nodeId: string, health: NodeHealth): ExecutionNode {
    const result = this.database.db.update(executionNodes)
      .set({ health })
      .where(eq(executionNodes.id, nodeId))
      .run();
    if (result.changes === 0) throw new Error(`Unknown node: ${nodeId}`);
    return this.getNode(nodeId)!;
  }

  getNode(nodeId: string): ExecutionNode | undefined {
    const row = this.database.db.select().from(executionNodes).where(eq(executionNodes.id, nodeId)).get();
    return row ? rowToNode(row) : undefined;
  }

  findNode(selector: string): ExecutionNode | undefined {
    const exact = this.getNode(selector);
    if (exact) return exact;
    const matches = this.database.db.select().from(executionNodes)
      .where(eq(executionNodes.alias, selector))
      .orderBy(desc(executionNodes.lastSeenAt))
      .all()
      .map(rowToNode);
    if (matches.length > 1) {
      throw new Error(`Execution node alias ${selector} is ambiguous; use a node id instead.`);
    }
    return matches[0];
  }

  listNodes(): ExecutionNode[] {
    return this.database.db.select().from(executionNodes)
      .orderBy(desc(executionNodes.lastSeenAt))
      .all()
      .map(rowToNode);
  }

  bindWorkspace(input: { workspaceId: string; nodeId: string; localWorkspaceId: string }): WorkspaceRoute {
    const now = new Date().toISOString();
    this.database.db.insert(workspaceRoutes).values({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      localWorkspaceId: input.localWorkspaceId,
      createdAt: now,
      lastUsedAt: now,
    }).onConflictDoUpdate({
      target: workspaceRoutes.workspaceId,
      set: { nodeId: input.nodeId, localWorkspaceId: input.localWorkspaceId, lastUsedAt: now },
    }).run();
    return this.resolveWorkspace(input.workspaceId)!;
  }

  resolveWorkspace(workspaceId: string): WorkspaceRoute | undefined {
    const row = this.database.db.select().from(workspaceRoutes)
      .where(eq(workspaceRoutes.workspaceId, workspaceId)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    this.database.db.update(workspaceRoutes).set({ lastUsedAt: now })
      .where(eq(workspaceRoutes.workspaceId, workspaceId)).run();
    return { ...row, lastUsedAt: now };
  }

  findWorkspaceByLocal(nodeId: string, localWorkspaceId: string): WorkspaceRoute | undefined {
    const row = this.database.db.select().from(workspaceRoutes)
      .where(eq(workspaceRoutes.nodeId, nodeId))
      .all()
      .find((candidate) => candidate.localWorkspaceId === localWorkspaceId);
    return row ?? undefined;
  }

  bindTask(input: { taskId: string; nodeId: string; workspaceId: string; localTaskId: string; runId?: string }): TaskRoute {
    const workspace = this.resolveWorkspace(input.workspaceId);
    if (!workspace || workspace.nodeId !== input.nodeId) {
      throw new Error(`Cannot bind task ${input.taskId}: workspace ${input.workspaceId} is not owned by node ${input.nodeId}.`);
    }
    const now = new Date().toISOString();
    this.database.db.insert(taskRoutes).values({
      taskId: input.taskId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      localTaskId: input.localTaskId,
      runId: input.runId ?? null,
      createdAt: now,
      lastUsedAt: now,
    }).onConflictDoUpdate({
      target: taskRoutes.taskId,
      set: {
        nodeId: input.nodeId,
        workspaceId: input.workspaceId,
        localTaskId: input.localTaskId,
        runId: input.runId ?? null,
        lastUsedAt: now,
      },
    }).run();
    return this.resolveTask(input.taskId)!;
  }

  resolveTask(taskId: string): TaskRoute | undefined {
    const row = this.database.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, taskId)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    this.database.db.update(taskRoutes).set({ lastUsedAt: now }).where(eq(taskRoutes.taskId, taskId)).run();
    return {
      taskId: row.taskId,
      nodeId: row.nodeId,
      workspaceId: row.workspaceId,
      localTaskId: row.localTaskId,
      runId: row.runId ?? undefined,
      createdAt: row.createdAt,
      lastUsedAt: now,
    };
  }

  findTaskByLocal(nodeId: string, localTaskId: string): TaskRoute | undefined {
    const row = this.database.db.select().from(taskRoutes)
      .where(eq(taskRoutes.nodeId, nodeId))
      .all()
      .find((candidate) => candidate.localTaskId === localTaskId);
    if (!row) return undefined;
    return {
      taskId: row.taskId,
      nodeId: row.nodeId,
      workspaceId: row.workspaceId,
      localTaskId: row.localTaskId,
      runId: row.runId ?? undefined,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  close(): void {
    this.database.close();
  }
}

function rowToNode(row: typeof executionNodes.$inferSelect): ExecutionNode {
  return {
    id: row.id,
    kind: row.kind as ExecutionNode["kind"],
    alias: row.alias ?? undefined,
    protocol: { major: row.protocolMajor, minor: row.protocolMinor },
    health: row.health as NodeHealth,
    platform: JSON.parse(row.platformJson) as NodePlatform,
    capabilities: JSON.parse(row.capabilitiesJson) as NodeCapabilities,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}
