import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolInvoker } from "../tool-invoker.js";
import type { NodeLinkRequest } from "./link-hub.js";
import { NodeWorkerClient } from "./worker-client.js";

test("worker uses secondary controller URL only for transport faults", async () => {
  const seen: string[] = [];
  let primaryStatus = 0;
  const client = new NodeWorkerClient({
    gatewayUrl: "http://127.0.0.1:7678",
    gatewayFallbackUrl: "https://controller.example",
    node: {
      id: "node_failover", kind: "local", health: "online",
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex", features: [], labels: {} },
      createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "test-token", pollWaitMs: 1_000, heartbeatMs: 15_000,
    invoker: { call: async () => ({}) } as unknown as ToolInvoker,
    fetchImpl: (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      seen.push(requestUrl);
      if (requestUrl.startsWith("http://127.0.0.1")) {
        if (primaryStatus === 0) throw new TypeError("SSH tunnel offline");
        return new Response("unauthorized", { status: primaryStatus });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const call = (client as unknown as {
    request(action: string, body: unknown, timeoutMs: number): Promise<unknown>;
  }).request.bind(client);
  assert.deepEqual(await call("heartbeat", {}, 2000), { ok: true });
  assert.equal(seen.length, 2);
  assert.ok(seen[1]?.startsWith("https://controller.example"));
  primaryStatus = 401;
  await assert.rejects(() => call("heartbeat", {}, 2000), /401/);
  assert.equal(seen.length, 3, "401 must not fall back to a different address");
});

test("worker runs parallel reads but preserves per-workspace write ordering", async () => {
  let releaseReads!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseReads = resolve; });
  const calls: string[] = [];
  const worker = new NodeWorkerClient({
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_concurrent", kind: "local", health: "online",
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex", features: [], labels: {} },
      createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token", pollWaitMs: 1_000, heartbeatMs: 15_000,
    invoker: {
      async call(name: string, args: { path?: string }) {
        calls.push(name === "read" ? String(args.path) : name);
        if (name === "read") await blocked;
        return { structuredContent: { ok: true } };
      },
    } as unknown as ToolInvoker,
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
  const schedule = (worker as unknown as {
    schedule(request: NodeLinkRequest): Promise<void>;
  }).schedule.bind(worker);
  const makeCall = (id: string, name: string, path?: string): NodeLinkRequest => ({
    id: `nrq_${id}`, createdAt: new Date().toISOString(),
    call: { name, arguments: { workspaceId: "ws_same", path } },
  });
  const first = schedule(makeCall("read-a", "read", "a"));
  const second = schedule(makeCall("read-b", "read", "b"));
  const write = schedule(makeCall("write", "apply_patch"));
  for (let i = 0; i < 30 && calls.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, ["a", "b"]);
  releaseReads();
  await Promise.all([first, second, write]);
  assert.deepEqual(calls, ["a", "b", "apply_patch"]);
  assert.equal((worker as unknown as { workspaceGates: Map<string, unknown> }).workspaceGates.size, 0,
    "completed workspaces must not retain scheduler gates indefinitely");
});

test("worker close interrupts reconnect backoff and heartbeat requests never overlap", async () => {
  let registrations = 0;
  let heartbeats = 0;
  const worker = new NodeWorkerClient({
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_backoff", kind: "local", health: "online",
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex", features: [], labels: {} },
      createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token", pollWaitMs: 1_000, heartbeatMs: 5,
    invoker: { call: async () => ({}) } as unknown as ToolInvoker,
    fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/register")) {
        registrations += 1;
        throw new Error("gateway unavailable");
      }
      heartbeats += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch,
  });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(registrations, 1);
  assert.equal(heartbeats, 1);
  const startedAt = performance.now();
  await worker.close();
  assert.ok(performance.now() - startedAt < 200);
});

test("worker replays a persisted completion instead of re-executing after delivery failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-worker-receipt-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const request: NodeLinkRequest = {
    id: "nrq_11111111-1111-4111-8111-111111111111",
    createdAt: new Date().toISOString(),
    call: {
      name: "exec_command",
      arguments: { workspaceId: "ws_local", cmd: "sleep 5" },
    },
  };
  let executions = 0;
  let completionAttempts = 0;
  const invoker = {
    async call() {
      executions += 1;
      return {
        content: [{ type: "text", text: "task=task_local working" }],
        structuredContent: { taskId: "task_local", runId: "run_local", running: true },
      };
    },
  } as unknown as ToolInvoker;
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!url.endsWith("/complete")) throw new Error(`Unexpected request: ${url}`);
    completionAttempts += 1;
    if (completionAttempts === 1) throw new Error("link dropped after execution");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const options = {
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_worker",
      kind: "local" as const,
      health: "online" as const,
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex" as const, features: [], labels: {} },
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token",
    pollWaitMs: 1_000,
    heartbeatMs: 15_000,
    invoker,
    fetchImpl: fetchImpl as typeof fetch,
    stateDir,
  };

  const firstWorker = new NodeWorkerClient(options);
  await assert.rejects(
    () => (firstWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request),
    /link dropped/,
  );
  assert.equal(executions, 1);

  const secondWorker = new NodeWorkerClient(options);
  await (secondWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request);
  assert.equal(executions, 1);
  assert.equal(completionAttempts, 2);
});

test("worker does not replay a non-idempotent tool after the started journal survives a crash window", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-worker-started-journal-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const request: NodeLinkRequest = {
    id: "nrq_22222222-2222-4222-8222-222222222222",
    createdAt: new Date().toISOString(),
    call: {
      name: "semantic_edit",
      arguments: {
        workspaceId: "ws_local",
        action: "insert_after",
        path: "src/example.ts",
        symbol: "target",
        body: "sideEffect();",
      },
    },
  };
  let executions = 0;
  const invoker = {
    async call() {
      executions += 1;
      return { structuredContent: { result: "edited" } };
    },
  } as unknown as ToolInvoker;
  const completions: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    completions.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const options = {
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_worker",
      kind: "local" as const,
      health: "online" as const,
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex" as const, features: [], labels: {} },
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token",
    pollWaitMs: 1_000,
    heartbeatMs: 15_000,
    invoker,
    fetchImpl: fetchImpl as typeof fetch,
    stateDir,
  };

  const firstWorker = new NodeWorkerClient(options);
  const originalWriteReceipt = (firstWorker as unknown as {
    writeReceipt(receipt: { state: string }): Promise<void>;
  }).writeReceipt.bind(firstWorker);
  let writes = 0;
  (firstWorker as unknown as {
    writeReceipt(receipt: { state: string }): Promise<void>;
  }).writeReceipt = async (receipt) => {
    writes += 1;
    if (writes === 2) throw new Error("crash after tool side effect");
    await originalWriteReceipt(receipt);
  };
  await assert.rejects(
    () => (firstWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request),
    /crash after tool side effect/,
  );
  assert.equal(executions, 1);

  const secondWorker = new NodeWorkerClient(options);
  await (secondWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request);
  assert.equal(executions, 1);
  const error = completions.at(-1)?.error as { name?: string } | undefined;
  assert.equal(error?.name, "IndeterminateNodeToolOutcome");
});

test("worker may replay a read-only tool after the started journal survives a crash window", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-worker-safe-replay-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });
  const request: NodeLinkRequest = {
    id: "nrq_33333333-3333-4333-8333-333333333333",
    createdAt: new Date().toISOString(),
    call: {
      name: "read",
      arguments: { workspaceId: "ws_local", path: "README.md" },
    },
  };
  let executions = 0;
  const invoker = {
    async call() {
      executions += 1;
      return { structuredContent: { result: "ok" } };
    },
  } as unknown as ToolInvoker;
  const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const options = {
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_worker",
      kind: "local" as const,
      health: "online" as const,
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex" as const, features: [], labels: {} },
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token",
    pollWaitMs: 1_000,
    heartbeatMs: 15_000,
    invoker,
    fetchImpl: fetchImpl as typeof fetch,
    stateDir,
  };

  const firstWorker = new NodeWorkerClient(options);
  const originalWriteReceipt = (firstWorker as unknown as {
    writeReceipt(receipt: { state: string }): Promise<void>;
  }).writeReceipt.bind(firstWorker);
  let writes = 0;
  (firstWorker as unknown as {
    writeReceipt(receipt: { state: string }): Promise<void>;
  }).writeReceipt = async (receipt) => {
    writes += 1;
    if (writes === 2) throw new Error("crash after read");
    await originalWriteReceipt(receipt);
  };
  await assert.rejects(
    () => (firstWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request),
    /crash after read/,
  );
  assert.equal(executions, 1);

  const secondWorker = new NodeWorkerClient(options);
  await (secondWorker as unknown as { execute(request: NodeLinkRequest): Promise<void> }).execute(request);
  assert.equal(executions, 2);
});

test("worker shutdown aborts concurrent poll and heartbeat requests", async () => {
  let activeLongRequests = 0;
  let abortedLongRequests = 0;
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/register")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!url.endsWith("/poll") && !url.endsWith("/heartbeat")) {
      throw new Error(`Unexpected request: ${url}`);
    }
    activeLongRequests += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        abortedLongRequests += 1;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  };
  const invoker = { call: async () => ({}) } as unknown as ToolInvoker;
  const worker = new NodeWorkerClient({
    gatewayUrl: "https://gateway.example",
    node: {
      id: "node_worker_shutdown",
      kind: "local",
      health: "online",
      protocol: { major: 1, minor: 0 },
      platform: { os: "linux", arch: "x64" },
      capabilities: { toolMode: "codex", features: [], labels: {} },
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
    nodeToken: "token",
    pollWaitMs: 1_000,
    heartbeatMs: 10,
    invoker,
    fetchImpl: fetchImpl as typeof fetch,
  });
  worker.start();
  for (let attempt = 0; attempt < 50 && activeLongRequests < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(activeLongRequests >= 2);
  const startedAt = performance.now();
  await worker.close();
  assert.ok(performance.now() - startedAt < 500);
  assert.ok(abortedLongRequests >= 2);
});
