import { randomBytes } from "node:crypto";

export const DEVSPACE_NODE_PROTOCOL = Object.freeze({ major: 1, minor: 1 });

export type NodeHealth = "online" | "suspect" | "offline" | "draining";

export interface NodePlatform {
  os: string;
  arch: string;
}

export interface NodeResources {
  logicalCpuCount?: number;
  memoryBytes?: number;
  gpus?: Array<{
    vendor?: string;
    name: string;
    memoryBytes?: number;
  }>;
}

export interface NodeCapabilities {
  toolMode: "claude" | "codex";
  features: string[];
  /** Contracts of actual registered tools; source hashes need not match. */
  toolContracts?: Record<string, number>;
  labels: Record<string, string>;
  runtime?: {
    version: string;
    buildFingerprint: string;
    buildSource?: SourceProvenance;
    checkoutSource?: SourceProvenance;
    sourceDrift?: boolean;
  };
  homeDir?: string;
  workspaceRoots?: string[];
  resources?: NodeResources;
}

export interface SourceProvenance {
  revision?: string;
  dirty?: boolean;
  fingerprint?: string;
}

export interface ExecutionNode {
  id: string;
  kind: "local" | "remote";
  alias?: string;
  protocol: {
    major: number;
    minor: number;
  };
  health: NodeHealth;
  platform: NodePlatform;
  capabilities: NodeCapabilities;
  createdAt: string;
  lastSeenAt: string;
}

export interface NodeRegistration {
  id?: string;
  alias?: string;
  protocol?: {
    major: number;
    minor: number;
  };
  platform: NodePlatform;
  capabilities: NodeCapabilities;
}

/**
 * A different source fingerprint does not make a node unusable. Compare the
 * requested tool contracts instead; this summary is diagnostic, not an
 * admission policy for individual routes.
 */
export function compareToolContracts(
  local: Record<string, number> | undefined,
  remote: Record<string, number> | undefined,
): { comparable: boolean; matching: number; missing: number; incompatible: number; total: number } {
  if (!local || !remote) {
    return { comparable: false, matching: 0, missing: 0, incompatible: 0, total: 0 };
  }
  let matching = 0;
  let missing = 0;
  let incompatible = 0;
  for (const [tool, version] of Object.entries(local)) {
    if (!(tool in remote)) missing++;
    else if (remote[tool] === version) matching++;
    else incompatible++;
  }
  return { comparable: true, matching, missing, incompatible, total: Object.keys(local).length };
}

export function createNodeId(): string {
  return `node_${randomBytes(10).toString("hex")}`;
}

export function nodeMatchesSelector(node: Pick<ExecutionNode, "id" | "alias">, selector: string): boolean {
  const normalized = selector.trim();
  return normalized === node.id || (node.alias !== undefined && normalized === node.alias);
}

export function assertNodeProtocolCompatible(
  remote: Pick<ExecutionNode, "id" | "protocol">,
  required = DEVSPACE_NODE_PROTOCOL,
): void {
  if (remote.protocol.major !== required.major) {
    throw new Error(
      `Node ${remote.id} uses incompatible protocol ${remote.protocol.major}.${remote.protocol.minor}; `
      + `this control plane requires major ${required.major}.`,
    );
  }
}
