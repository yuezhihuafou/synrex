import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { ExecutionNode } from "./protocol.js";
import type { NodeLinkRequest } from "./link-hub.js";
import type { ToolInvoker } from "../tool-invoker.js";
import { runWithRequestLogContext } from "../logger.js";
import { traceEvent, traceStage, errorCategory } from "../trace-stages.js";
import { newSpanId, validOtelContext } from "../otel-context.js";
import type { DiagnosticEvent } from "../diagnostic-trace.js";

export interface NodeWorkerClientOptions {
  gatewayUrl: string;
  gatewayFallbackUrl?: string | null;
  node: ExecutionNode;
  nodeToken: string;
  pollWaitMs: number;
  heartbeatMs: number;
  invoker: ToolInvoker;
  fetchImpl?: typeof fetch;
  stateDir?: string;
  maxConcurrentCalls?: number;
  /** Canonical peer-local checkout root; conversation workspace IDs may differ. */
  resolveWorkspaceRoot?: (workspaceId: string) => Promise<string>;
  onMetric?: (event: string, fields: Record<string, string | number | boolean>) => void;
  onDiagnostic?: (event: DiagnosticEvent, fields: Record<string, unknown>) => void;
}

interface NodeRequestReceipt {
  schemaVersion: 1;
  requestId: string;
  createdAt: string;
  state: "started" | "completed";
  toolName: string;
  result?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
  };
}

export class NodeWorkerClient {
  private readonly fetchImpl: typeof fetch;
  private stopped = false;
  private loopPromise?: Promise<void>;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly activeRequests = new Set<AbortController>();
  private readonly receipts = new Map<string, NodeRequestReceipt>();
  private stopController = new AbortController();
  private heartbeatPending = false;
  private pollEpoch = 0;
  private readonly workspaceGates = new Map<string, { tail: Promise<void>; reads: Set<Promise<void>>; pending: number }>();

  constructor(private readonly options: NodeWorkerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.stopController = new AbortController();
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = undefined;
    });
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, this.options.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.pollEpoch += 1;
    this.stopController.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const controller of this.activeRequests) controller.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  async register(): Promise<void> {
    await this.request("register", {
      node: {
        id: this.options.node.id,
        alias: this.options.node.alias,
        protocol: this.options.node.protocol,
        platform: this.options.node.platform,
        capabilities: this.options.node.capabilities,
      },
    }, Math.max(10_000, this.options.pollWaitMs));
  }

  private async runLoop(): Promise<void> {
    let backoffMs = 500;
    while (!this.stopped) {
      try {
        await this.register();
        backoffMs = 500;
        const epoch = ++this.pollEpoch;
        const count = Math.max(1, Math.min(4, this.options.maxConcurrentCalls ?? 4));
        const pollers = Array.from({ length: count }, () => this.pollLoop(epoch).catch((error: unknown) => {
          if (epoch === this.pollEpoch) this.pollEpoch += 1;
          throw error;
        }));
        const results = await Promise.allSettled(pollers);
        const failed = results.find((result) => result.status === "rejected");
        if (failed && failed.status === "rejected") throw failed.reason;
      } catch (error) {
        if (this.stopped) return;
        try { this.options.onDiagnostic?.("node_transport", { nodeId: this.options.node.id, outcome: "error", errorCategory: errorCategory(error), queuedMs: backoffMs }); } catch { /* Observational. */ }
        await wait(backoffMs, undefined, { signal: this.stopController.signal }).catch(() => undefined);
        backoffMs = Math.min(10_000, backoffMs * 2);
      }
    }
  }

  private async pollLoop(epoch: number): Promise<void> {
    while (!this.stopped && epoch === this.pollEpoch) {
      const response = await this.request("poll", {
        nodeId: this.options.node.id,
        waitMs: this.options.pollWaitMs,
      }, this.options.pollWaitMs + 10_000) as { request?: NodeLinkRequest | null };
      if (!response.request) continue;
      try {
        await this.schedule(response.request);
      } catch (error) {
        this.options.onMetric?.("node_execution_error", {
          tool: response.request.call.name,
          error: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
    }
  }

  // Reads may overlap, while all non-read operations execute exclusively for
  // their workspace. Preserve delivery order without serializing other projects.
  private async schedule(request: NodeLinkRequest): Promise<void> {
    const receivedAt = performance.now();
    const fields = { requestId: request.id, nodeRequestId: request.id, traceId: request.call.meta?.["devspace/traceId"],
      otelTraceId: request.call.meta?.["devspace/otelTraceId"], nodeId: this.options.node.id, tool: request.call.name };
    try { this.options.onDiagnostic?.("node_peer_received", fields); } catch { /* Observational. */ }
    const execute = () => {
      try { this.options.onDiagnostic?.("node_peer_started", { ...fields, queuedMs: Math.round(performance.now() - receivedAt) }); } catch { /* Observational. */ }
      return this.execute(request);
    };
    const workspaceId = request.call.arguments.workspaceId;
    const key = typeof workspaceId === "string"
      ? await this.options.resolveWorkspaceRoot?.(workspaceId).catch(() => undefined) ?? `workspace:${workspaceId}`
      : "__global__";
    let gate = this.workspaceGates.get(key);
    if (!gate) {
      gate = { tail: Promise.resolve(), reads: new Set(), pending: 0 };
      this.workspaceGates.set(key, gate);
    }
    gate.pending += 1;
    let execution: Promise<void>;
    if (isParallelRead(request.call.name)) {
      execution = gate.tail.then(execute);
      const settled = execution.then(() => undefined, () => undefined);
      gate.reads.add(settled);
      void settled.then(() => gate!.reads.delete(settled));
    } else {
      const previous = Promise.all([gate.tail, ...gate.reads]);
      gate.reads.clear();
      execution = previous.then(execute);
      gate.tail = execution.then(() => undefined, () => undefined);
    }
    return execution.finally(() => {
      gate!.pending -= 1;
      if (gate!.pending === 0 && this.workspaceGates.get(key) === gate) {
        this.workspaceGates.delete(key);
      }
    });
  }

  private async execute(request: NodeLinkRequest): Promise<void> {
    const startedAt = performance.now();
    try {
      const parent = request.call.meta?.["devspace/parentRequestId"];
      const trace = request.call.meta?.["devspace/traceId"];
      const otelTraceId = request.call.meta?.["devspace/otelTraceId"];
      const otelParentSpanId = request.call.meta?.["devspace/otelParentSpanId"];
      const otel = validOtelContext({ otelTraceId, otelSpanId: newSpanId(), otelParentSpanId });
      await runWithRequestLogContext({ requestId: typeof parent === "string" ? parent : request.id,
        traceId: typeof trace === "string" ? trace : request.id, nodeRequestId: request.id, path: "peer",
        ...(otel ?? {}),
        emitDiagnostic: this.options.onDiagnostic,
      }, () => traceStage("peer_execute", () => this.executeWithReceipt(request), { nodeId: this.options.node.id, tool: request.call.name }));
    } finally {
      this.options.onMetric?.("node_execution", {
        tool: request.call.name,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }
  }

  private async executeWithReceipt(request: NodeLinkRequest): Promise<void> {
    let receipt = await this.readReceipt(request.id);
    if (receipt?.state === "started") {
      if (receipt.toolName !== request.call.name) {
        throw new Error(
          `Node request ${request.id} changed tool identity from ${receipt.toolName} to ${request.call.name}.`,
        );
      }
      if (!isReplaySafeCall(request)) {
        receipt = {
          schemaVersion: 1,
          requestId: request.id,
          createdAt: receipt.createdAt,
          state: "completed",
          toolName: request.call.name,
          error: {
            name: "IndeterminateNodeToolOutcome",
            message:
              `Node request ${request.id} was interrupted after ${request.call.name} started. `
              + "Synrex refuses to replay this non-idempotent operation automatically; inspect the workspace before retrying.",
          },
        };
        await this.writeReceipt(receipt);
      } else {
        receipt = undefined;
      }
    }
    if (!receipt) {
      const started: NodeRequestReceipt = {
        schemaVersion: 1,
        requestId: request.id,
        createdAt: new Date().toISOString(),
        state: "started",
        toolName: request.call.name,
      };
      await this.writeReceipt(started);
      try {
        const result = await this.options.invoker.call(
          request.call.name,
          request.call.arguments,
          {
            ...request.call.meta,
            "devspace/nodeRequestId": request.id,
          },
        );
        receipt = {
          schemaVersion: 1,
          requestId: request.id,
          createdAt: started.createdAt,
          state: "completed",
          toolName: request.call.name,
          result,
        };
      } catch (error) {
        receipt = {
          schemaVersion: 1,
          requestId: request.id,
          createdAt: started.createdAt,
          state: "completed",
          toolName: request.call.name,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      await this.writeReceipt(receipt);
    }

    traceEvent("node_peer_finished", { tool: request.call.name, outcome: receipt.error || receipt.result?.isError === true ? "error" : "ok" });
    await traceStage("peer_ack", () => this.request("complete", {
      nodeId: this.options.node.id,
      requestId: request.id,
      ...(receipt.error ? { error: receipt.error } : { result: receipt.result }),
    }, 30_000));
    traceEvent("node_peer_acknowledged", { tool: request.call.name });
    await this.deleteReceipt(request.id);
  }

  private receiptPath(requestId: string): string | undefined {
    if (!this.options.stateDir || !/^nrq_[A-Za-z0-9-]+$/.test(requestId)) return undefined;
    return path.join(this.options.stateDir, "node-completions", `${requestId}.json`);
  }

  private async readReceipt(requestId: string): Promise<NodeRequestReceipt | undefined> {
    const cached = this.receipts.get(requestId);
    if (cached) return cached;
    const receiptPath = this.receiptPath(requestId);
    if (!receiptPath) return undefined;
    try {
      const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as NodeRequestReceipt;
      if (
        parsed.schemaVersion !== 1
        || parsed.requestId !== requestId
        || (parsed.state !== "started" && parsed.state !== "completed")
        || typeof parsed.toolName !== "string"
      ) return undefined;
      this.receipts.set(requestId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writeReceipt(receipt: NodeRequestReceipt): Promise<void> {
    this.receipts.set(receipt.requestId, receipt);
    const receiptPath = this.receiptPath(receipt.requestId);
    if (!receiptPath) return;
    await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    const temporary = `${receiptPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, receiptPath);
  }

  private async deleteReceipt(requestId: string): Promise<void> {
    this.receipts.delete(requestId);
    const receiptPath = this.receiptPath(requestId);
    if (receiptPath) await rm(receiptPath, { force: true });
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      await this.request("heartbeat", { nodeId: this.options.node.id }, 10_000);
    } finally {
      this.heartbeatPending = false;
    }
  }

  private async request(action: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const urls = [this.options.gatewayUrl];
    if (this.options.gatewayFallbackUrl && this.options.gatewayFallbackUrl !== this.options.gatewayUrl) {
      urls.push(this.options.gatewayFallbackUrl);
    }
    for (let i = 0; i < urls.length; i += 1) {
      const controller = new AbortController();
      this.activeRequests.add(controller);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let nonRetryableHttpError = false;
      try {
        const response = await this.fetchImpl(nodeApiUrl(urls[i]!, action), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.nodeToken}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const failure = new Error(`Gateway node API ${action} failed (${response.status}): ${detail.slice(0, 500)}`);
          // Permission or schema errors must not be hidden by switching transport.
          if (i === urls.length - 1 || ![502, 503, 504].includes(response.status)) {
            nonRetryableHttpError = true;
            throw failure;
          }
          this.options.onMetric?.("node_transport_fallback", { action, status: response.status });
          continue;
        }
        return await response.json();
      } catch (error) {
        if (nonRetryableHttpError || i === urls.length - 1 || this.stopped || controller.signal.aborted) throw error;
        this.options.onMetric?.("node_transport_fallback", {
          action, reason: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        clearTimeout(timeout);
        this.activeRequests.delete(controller);
      }
    }
    throw new Error(`No available node transport for ${action}.`);
  }
}

function isParallelRead(tool: string): boolean {
  return tool === "read" || tool === "semantic_code" || tool === "process_status" || tool === "task_get" || tool === "task_wait";
}

function isReplaySafeCall(request: NodeLinkRequest): boolean {
  switch (request.call.name) {
    case "read":
    case "semantic_code":
    case "task_get":
    case "task_wait":
    case "process_status":
      return true;
    case "exec_command":
      // Non-TTY commands use the durable-task request index keyed by this same
      // node request ID, so replay returns the existing task instead of
      // launching the command twice. Interactive sessions do not have that
      // idempotency contract.
      return request.call.arguments.tty !== true;
    default:
      return false;
  }
}

export function nodeApiUrl(gatewayUrl: string, action: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/_devspace/node/v1/${action}`;
}
