import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { deriveNodeToken } from "./auth.js";
import { registerGatewayNodeRoutes } from "./gateway-routes.js";
import { NodeLinkHub } from "./link-hub.js";
import { SqliteControlPlaneStore } from "./store.js";

test("gateway node API registers, authenticates, polls, and completes work", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-gateway-routes-"));
  const store = new SqliteControlPlaneStore(stateDir);
  const hub = new NodeLinkHub(5_000);
  const joinToken = "test-join-token-that-is-long-enough";
  const app = express();
  registerGatewayNodeRoutes(app, { joinToken, pollWaitMs: 2_000, store, hub });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  t.after(async () => {
    hub.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/_devspace/node/v1`;
  const nodeId = "node_0123456789abcdef0123";
  const registration = await post(`${base}/register`, joinToken, {
    node: {
      id: nodeId,
      alias: "worker",
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex", features: ["filesystem.read"], labels: {} },
    },
  });
  assert.equal(registration.status, 200);
  const nodeToken = deriveNodeToken(joinToken, nodeId);
  assert.equal((registration.body as { nodeToken?: string }).nodeToken, nodeToken);
  assert.equal(store.getNode(nodeId)?.health, "online");

  const resultPromise = hub.call(nodeId, { name: "read", arguments: { workspaceId: "ws_local" } });
  const poll = await post(`${base}/poll`, nodeToken, { nodeId, waitMs: 1_000 });
  assert.equal(poll.status, 200);
  const request = (poll.body as { request?: { id?: string; call?: { name?: string } } }).request;
  assert.equal(request?.call?.name, "read");
  assert.ok(request?.id);

  const complete = await post(`${base}/complete`, nodeToken, {
    nodeId,
    requestId: request.id,
    result: { structuredContent: { result: "remote-ok" } },
  });
  assert.equal(complete.status, 200);
  assert.deepEqual(await resultPromise, { structuredContent: { result: "remote-ok" } });

  const denied = await post(`${base}/heartbeat`, "wrong-token", { nodeId });
  assert.equal(denied.status, 401);
});

async function post(url: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
