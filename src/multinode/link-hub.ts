import { randomUUID } from "node:crypto";
import type { NodeToolCall, NodeToolResult, NodeTransport } from "./router.js";
import { currentRequestLogContext } from "../logger.js";
import type { DiagnosticEvent } from "../diagnostic-trace.js";

export interface NodeLinkRequest {
  id: string;
  call: NodeToolCall;
  createdAt: string;
}

interface PendingDispatch {
  nodeId: string;
  request: NodeLinkRequest;
  waiters: Array<{
    resolve: (result: NodeToolResult) => void;
    reject: (error: Error) => void;
  }>;
  timeout: NodeJS.Timeout;
  delivered: boolean;
  deliveredAt?: number;
}

interface PollWaiter {
  resolve: (request: NodeLinkRequest | undefined) => void;
  timeout: NodeJS.Timeout;
}

export class NodeLinkHub implements NodeTransport {
  private readonly queues = new Map<string, PendingDispatch[]>();
  private readonly pendingById = new Map<string, PendingDispatch>();
  private readonly pollWaiters = new Map<string, Set<PollWaiter>>();
  private closed = false;
  private readonly acknowledgements = new Map<string, { nodeId: string; expiresAt: number }>();
  private readonly timedOut = new Map<string, { nodeId: string; expiresAt: number; fields?: Record<string, unknown> }>();

  constructor(
    private readonly requestTimeoutMs: number,
    private readonly deliveryLeaseMs = Math.min(30_000, Math.max(1_000, Math.floor(requestTimeoutMs / 3))),
    private readonly onEvent?: (event: DiagnosticEvent, fields: Record<string, unknown>) => void,
  ) {}

  call(nodeId: string, input: NodeToolCall): Promise<NodeToolResult> {
    if (this.closed) return Promise.reject(new Error("Node link hub is closed."));
    const context = currentRequestLogContext();
    const request: NodeLinkRequest = {
      id: "nrq_" + randomUUID(),
      call: { ...input, meta: { ...input.meta,
        "devspace/traceId": context?.traceId ?? context?.requestId,
        "devspace/parentRequestId": context?.requestId,
        "devspace/callId": context?.callId,
        "devspace/otelTraceId": context?.otelTraceId,
        "devspace/otelParentSpanId": context?.otelSpanId,
      } },
      createdAt: new Date().toISOString(),
    };
    const fields = { requestId: request.id, nodeRequestId: request.id, traceId: context?.traceId ?? context?.requestId,
      otelTraceId: context?.otelTraceId, otelSpanId: context?.otelSpanId,
      callId: context?.callId, nodeId, tool: input.name };
    this.emitEvent("node_queued", fields);
    return new Promise<NodeToolResult>((resolve, reject) => {
      const pending: PendingDispatch = {
        nodeId,
        request,
        waiters: [{ resolve, reject }],
        delivered: false,
        timeout: setTimeout(() => {
          this.removePending(nodeId, request.id);
          const outcome = pending.delivered ? "indeterminate_after_dispatch" : "not_dispatched";
          if (pending.delivered) this.rememberTimeout(nodeId, request.id, fields);
          this.emitEvent("node_request_timeout", { ...fields, outcome });
          const error = new Error(`Node ${nodeId} did not complete request ${request.id} within ${this.requestTimeoutMs}ms (${outcome}).`
            + (pending.delivered ? " The remote operation may still be running or completed. Inspect its owner before retrying; do not replay a mutating operation." : " The request was never delivered."));
          for (const waiter of pending.waiters) waiter.reject(error);
        }, this.requestTimeoutMs),
      };
      pending.timeout.unref?.();
      this.pendingById.set(request.id, pending);
      const waiters = this.pollWaiters.get(nodeId);
      const waiter = waiters?.values().next().value;
      if (waiter) {
        this.removePollWaiter(nodeId, waiter);
        clearTimeout(waiter.timeout);
        pending.delivered = true;
        pending.deliveredAt = Date.now();
        this.emitEvent("node_delivered", { ...fields, queuedMs: Date.now() - Date.parse(request.createdAt) });
        waiter.resolve(request);
        return;
      }
      const queue = this.queues.get(nodeId) ?? [];
      queue.push(pending);
      this.queues.set(nodeId, queue);
    });
  }

  poll(nodeId: string, waitMs: number): Promise<NodeLinkRequest | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const queued = this.nextQueued(nodeId);
    if (queued) return Promise.resolve(queued.request);
    const redelivery = this.nextExpiredDelivery(nodeId);
    if (redelivery) return Promise.resolve(redelivery.request);

    return new Promise((resolve) => {
      const waiter: PollWaiter = { resolve, timeout: undefined as unknown as NodeJS.Timeout };
      const timeout = setTimeout(() => {
        this.removePollWaiter(nodeId, waiter);
        resolve(undefined);
      }, waitMs);
      timeout.unref?.();
      waiter.timeout = timeout;
      const waiters = this.pollWaiters.get(nodeId) ?? new Set<PollWaiter>();
      waiters.add(waiter);
      this.pollWaiters.set(nodeId, waiters);
    });
  }

  complete(nodeId: string, requestId: string, result: NodeToolResult): boolean {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return this.recordLateCompletion(nodeId, requestId) || this.wasAcknowledged(nodeId, requestId);
    }
    if (!this.belongsToNode(nodeId, pending)) {
      throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    }
    this.removePending(nodeId, requestId);
    this.rememberAcknowledgement(nodeId, requestId);
    this.emitEvent("node_completed", { ...this.requestFields(pending), outcome: result.isError === true ? "error" : "ok", durationMs: Date.now() - Date.parse(pending.request.createdAt) });
    for (const waiter of pending.waiters) waiter.resolve(result);
    return true;
  }

  fail(nodeId: string, requestId: string, message: string): boolean {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return this.recordLateCompletion(nodeId, requestId) || this.wasAcknowledged(nodeId, requestId);
    }
    if (!this.belongsToNode(nodeId, pending)) {
      throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    }
    this.removePending(nodeId, requestId);
    this.rememberAcknowledgement(nodeId, requestId);
    this.emitEvent("node_completed", { ...this.requestFields(pending), outcome: "error", errorCategory: "transport", durationMs: Date.now() - Date.parse(pending.request.createdAt) });
    const error = new Error(message);
    for (const waiter of pending.waiters) waiter.reject(error);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiters of this.pollWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(undefined);
      }
    }
    this.pollWaiters.clear();
    for (const pending of this.pendingById.values()) {
      clearTimeout(pending.timeout);
      const error = new Error("Node link hub closed before the request completed.");
      for (const waiter of pending.waiters) waiter.reject(error);
    }
    this.pendingById.clear();
    this.queues.clear();
    this.acknowledgements.clear();
    this.timedOut.clear();
  }

  private rememberTimeout(nodeId: string, requestId: string, fields?: Record<string, unknown>): void {
    const now = Date.now();
    for (const [id, entry] of this.timedOut) if (entry.expiresAt <= now) this.timedOut.delete(id);
    while (this.timedOut.size >= 4096) this.timedOut.delete(this.timedOut.keys().next().value!);
    this.timedOut.set(requestId, { nodeId, expiresAt: now + 300_000, fields });
  }

  private recordLateCompletion(nodeId: string, requestId: string): boolean {
    const entry = this.timedOut.get(requestId);
    if (!entry || entry.expiresAt <= Date.now()) return false;
    if (entry.nodeId !== nodeId) throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    this.emitEvent("node_late_completion", { ...entry.fields, requestId, nodeRequestId: requestId, nodeId, outcome: "completed_after_host_timeout" });
    this.timedOut.delete(requestId);
    this.rememberAcknowledgement(nodeId, requestId);
    // Acknowledge receipt so the peer can drop its durable completion record.
    // This does NOT retroactively mark the timed-out host tool call successful.
    return true;
  }

  private requestFields(pending: PendingDispatch): Record<string, unknown> {
    return { requestId: pending.request.id, nodeRequestId: pending.request.id, nodeId: pending.nodeId, tool: pending.request.call.name,
      traceId: pending.request.call.meta?.["devspace/traceId"], callId: pending.request.call.meta?.["devspace/callId"],
      otelTraceId: pending.request.call.meta?.["devspace/otelTraceId"],
      otelSpanId: pending.request.call.meta?.["devspace/otelParentSpanId"] };
  }

  private emitEvent(event: DiagnosticEvent, fields: Record<string, unknown>): void {
    try { this.onEvent?.(event, fields); }
    catch { /* Diagnostic emitters must never strand the pending RPC. */ }
  }

  private rememberAcknowledgement(nodeId: string, requestId: string): void {
    const now = Date.now();
    for (const [id, receipt] of this.acknowledgements) {
      if (receipt.expiresAt <= now) this.acknowledgements.delete(id);
    }
    // A lost HTTP response must not turn a successful completion into a 409.
    // Retain only ownership metadata, with bounded lifetime and memory.
    while (this.acknowledgements.size >= 4096) {
      this.acknowledgements.delete(this.acknowledgements.keys().next().value!);
    }
    this.acknowledgements.set(requestId, { nodeId, expiresAt: now + 300_000 });
  }

  private removePollWaiter(nodeId: string, waiter: PollWaiter): void {
    const waiters = this.pollWaiters.get(nodeId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.pollWaiters.delete(nodeId);
  }

  private wasAcknowledged(nodeId: string, requestId: string): boolean {
    const receipt = this.acknowledgements.get(requestId);
    if (!receipt) return false;
    if (receipt.expiresAt <= Date.now()) {
      this.acknowledgements.delete(requestId);
      return false;
    }
    if (receipt.nodeId !== nodeId) {
      throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    }
    return true;
  }

  private nextQueued(nodeId: string): PendingDispatch | undefined {
    const queue = this.queues.get(nodeId);
    while (queue && queue.length > 0) {
      const pending = queue.shift()!;
      if (!this.pendingById.has(pending.request.id)) continue;
      pending.delivered = true;
      pending.deliveredAt = Date.now();
      this.emitEvent("node_delivered", { ...this.requestFields(pending), queuedMs: Date.now() - Date.parse(pending.request.createdAt) });
      if (queue.length === 0) this.queues.delete(nodeId);
      return pending;
    }
    if (queue?.length === 0) this.queues.delete(nodeId);
    return undefined;
  }

  private nextExpiredDelivery(nodeId: string): PendingDispatch | undefined {
    const cutoff = Date.now() - this.deliveryLeaseMs;
    for (const pending of this.pendingById.values()) {
      if (
        pending.nodeId !== nodeId
        || !pending.delivered
        || pending.deliveredAt === undefined
        || pending.deliveredAt > cutoff
      ) continue;
      pending.deliveredAt = Date.now();
      this.emitEvent("node_delivered", { ...this.requestFields(pending), queuedMs: Date.now() - Date.parse(pending.request.createdAt), phase: 1 });
      return pending;
    }
    return undefined;
  }

  private removePending(nodeId: string, requestId: string): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingById.delete(requestId);
    const queue = this.queues.get(nodeId);
    if (!queue) return;
    const next = queue.filter((candidate) => candidate.request.id !== requestId);
    if (next.length > 0) this.queues.set(nodeId, next);
    else this.queues.delete(nodeId);
  }

  private belongsToNode(nodeId: string, pending: PendingDispatch): boolean {
    return pending.nodeId === nodeId;
  }
}
