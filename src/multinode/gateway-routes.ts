import type { Express, Request, Response } from "express";
import express from "express";
import { bearerToken, deriveNodeToken, safeTokenEquals } from "./auth.js";
import { assertNodeProtocolCompatible, type NodeRegistration } from "./protocol.js";
import type { NodeLinkHub } from "./link-hub.js";
import type { ControlPlaneStore } from "./store.js";

export interface GatewayNodeRoutesOptions {
  joinToken: string;
  pollWaitMs: number;
  store: ControlPlaneStore;
  hub: NodeLinkHub;
}

export function registerGatewayNodeRoutes(app: Express, options: GatewayNodeRoutesOptions): void {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  router.post("/register", (req, res) => {
    try {
      const registration = parseRegistration(req.body?.node);
      const nodeId = registration.id;
      if (!nodeId) throw new Error("Node registration requires id.");
      const auth = bearerToken(req.header("authorization"));
      const nodeToken = deriveNodeToken(options.joinToken, nodeId);
      if (!safeTokenEquals(auth, options.joinToken) && !safeTokenEquals(auth, nodeToken)) {
        res.status(401).json({ error: "invalid_node_credential" });
        return;
      }
      assertNodeProtocolCompatible({
        id: nodeId,
        protocol: registration.protocol ?? { major: 1, minor: 0 },
      });
      const node = options.store.registerRemoteNode(registration as NodeRegistration & { id: string });
      options.store.heartbeat(node.id);
      res.json({
        ok: true,
        nodeToken,
        node: compactNode(node),
        pollWaitMs: options.pollWaitMs,
      });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  router.post("/heartbeat", (req, res) => {
    const nodeId = bodyNodeId(req, res, options);
    if (!nodeId) return;
    const node = options.store.heartbeat(nodeId);
    res.json({ ok: true, health: node.health });
  });

  router.post("/poll", async (req, res) => {
    const nodeId = bodyNodeId(req, res, options);
    if (!nodeId) return;
    options.store.heartbeat(nodeId);
    const requestedWait = typeof req.body?.waitMs === "number" ? req.body.waitMs : options.pollWaitMs;
    const waitMs = Math.max(1_000, Math.min(options.pollWaitMs, Math.floor(requestedWait)));
    const request = await options.hub.poll(nodeId, waitMs);
    res.json({ ok: true, request: request ?? null });
  });

  router.post("/complete", (req, res) => {
    const nodeId = bodyNodeId(req, res, options);
    if (!nodeId) return;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : undefined;
    if (!requestId) {
      res.status(400).json({ error: "missing_request_id" });
      return;
    }
    options.store.heartbeat(nodeId);
    let accepted: boolean;
    if (req.body?.error && typeof req.body.error === "object") {
      const message = typeof req.body.error.message === "string"
        ? req.body.error.message
        : "Remote node tool call failed.";
      accepted = options.hub.fail(nodeId, requestId, message);
    } else {
      const result = req.body?.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        res.status(400).json({ error: "missing_result" });
        return;
      }
      accepted = options.hub.complete(nodeId, requestId, result as Record<string, unknown>);
    }
    if (!accepted) {
      res.status(409).json({ error: "unknown_request" });
      return;
    }
    res.json({ ok: true });
  });

  app.use("/_devspace/node/v1", router);
}

function bodyNodeId(
  req: Request,
  res: Response,
  options: GatewayNodeRoutesOptions,
): string | undefined {
  const nodeId = typeof req.body?.nodeId === "string" ? req.body.nodeId : undefined;
  if (!nodeId || !options.store.getNode(nodeId)) {
    res.status(404).json({ error: "unknown_node" });
    return undefined;
  }
  const expected = deriveNodeToken(options.joinToken, nodeId);
  if (!safeTokenEquals(bearerToken(req.header("authorization")), expected)) {
    res.status(401).json({ error: "invalid_node_credential" });
    return undefined;
  }
  return nodeId;
}

function parseRegistration(value: unknown): NodeRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid node registration.");
  }
  const input = value as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id : undefined;
  const alias = typeof input.alias === "string" ? input.alias : undefined;
  const protocolValue = input.protocol as Record<string, unknown> | undefined;
  const platformValue = input.platform as Record<string, unknown> | undefined;
  const capabilitiesValue = input.capabilities as Record<string, unknown> | undefined;
  if (!id?.startsWith("node_")) throw new Error("Invalid node id.");
  if (!protocolValue || typeof protocolValue.major !== "number" || typeof protocolValue.minor !== "number") {
    throw new Error("Invalid node protocol.");
  }
  if (!platformValue || typeof platformValue.os !== "string" || typeof platformValue.arch !== "string") {
    throw new Error("Invalid node platform.");
  }
  if (!capabilitiesValue || (capabilitiesValue.toolMode !== "codex" && capabilitiesValue.toolMode !== "claude")) {
    throw new Error("Invalid node capabilities.");
  }
  const features = Array.isArray(capabilitiesValue.features)
    ? capabilitiesValue.features.filter((item): item is string => typeof item === "string")
    : [];
  const labels = capabilitiesValue.labels && typeof capabilitiesValue.labels === "object" && !Array.isArray(capabilitiesValue.labels)
    ? Object.fromEntries(Object.entries(capabilitiesValue.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const workspaceRoots = Array.isArray(capabilitiesValue.workspaceRoots)
    ? capabilitiesValue.workspaceRoots.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
  const homeDir = typeof capabilitiesValue.homeDir === "string" && capabilitiesValue.homeDir.length > 0
    ? capabilitiesValue.homeDir
    : undefined;
  const runtimeValue = capabilitiesValue.runtime as Record<string, unknown> | undefined;
  const contractsValue = capabilitiesValue.toolContracts;
  let toolContracts: Record<string, number> | undefined;
  if (contractsValue !== undefined) {
    if (!contractsValue || typeof contractsValue !== "object" || Array.isArray(contractsValue)) {
      throw new Error("Invalid node tool contracts.");
    }
    const entries = Object.entries(contractsValue);
    if (entries.length > 128 || entries.some(([name, version]) =>
      !/^[a-z][a-z0-9_]{0,79}$/.test(name) || !Number.isSafeInteger(version) || Number(version) < 1 || Number(version) > 100
    )) {
      throw new Error("Invalid node tool contract entry.");
    }
    toolContracts = Object.fromEntries(entries) as Record<string, number>;
  }
  const runtime = runtimeValue
    && typeof runtimeValue.version === "string"
    && typeof runtimeValue.buildFingerprint === "string"
    ? {
        version: runtimeValue.version,
        buildFingerprint: runtimeValue.buildFingerprint,
        buildSource: parseSourceProvenance(runtimeValue.buildSource),
        checkoutSource: parseSourceProvenance(runtimeValue.checkoutSource),
        sourceDrift: typeof runtimeValue.sourceDrift === "boolean"
          ? runtimeValue.sourceDrift
          : undefined,
      }
    : undefined;
  return {
    id,
    alias,
    protocol: { major: protocolValue.major, minor: protocolValue.minor },
    platform: { os: platformValue.os, arch: platformValue.arch },
    capabilities: {
      toolMode: capabilitiesValue.toolMode,
      features,
      ...(toolContracts ? { toolContracts } : {}),
      labels,
      runtime,
      homeDir,
      workspaceRoots,
      resources: capabilitiesValue.resources as NodeRegistration["capabilities"]["resources"],
    },
  };
}

function parseSourceProvenance(value: unknown): {
  revision?: string;
  dirty?: boolean;
  fingerprint?: string;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const parsed = {
    ...(typeof input.revision === "string" ? { revision: input.revision } : {}),
    ...(typeof input.dirty === "boolean" ? { dirty: input.dirty } : {}),
    ...(typeof input.fingerprint === "string" ? { fingerprint: input.fingerprint } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function compactNode(node: ReturnType<ControlPlaneStore["getNode"]> & {}): Record<string, unknown> {
  return node ? {
    id: node.id,
    alias: node.alias,
    health: node.health,
    protocol: node.protocol,
    runtime: node.capabilities.runtime,
  } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
