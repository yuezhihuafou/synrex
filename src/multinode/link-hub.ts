import { randomUUID } from "node:crypto";
import type { NodeToolCall, NodeToolResult, NodeTransport } from "./router.js";

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

  constructor(
    private readonly requestTimeoutMs: number,
    private readonly deliveryLeaseMs = Math.min(30_000, Math.max(1_000, Math.floor(requestTimeoutMs / 3))),
  ) {}

  call(nodeId: string, input: NodeToolCall): Promise<NodeToolResult> {
    if (this.closed) return Promise.reject(new Error("Node link hub is closed."));
    const request: NodeLinkRequest = {
      id: "nrq_" + randomUUID(),
      call: input,
      createdAt: new Date().toISOString(),
    };
    return new Promise<NodeToolResult>((resolve, reject) => {
      const pending: PendingDispatch = {
        nodeId,
        request,
        waiters: [{ resolve, reject }],
        delivered: false,
        timeout: setTimeout(() => {
          this.removePending(nodeId, request.id);
          const error = new Error(`Node ${nodeId} did not complete request ${request.id} within ${this.requestTimeoutMs}ms.`);
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
    if (!pending) return this.wasAcknowledged(nodeId, requestId);
    if (!this.belongsToNode(nodeId, pending)) {
      throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    }
    this.removePending(nodeId, requestId);
    this.rememberAcknowledgement(nodeId, requestId);
    for (const waiter of pending.waiters) waiter.resolve(result);
    return true;
  }

  fail(nodeId: string, requestId: string, message: string): boolean {
    const pending = this.pendingById.get(requestId);
    if (!pending) return this.wasAcknowledged(nodeId, requestId);
    if (!this.belongsToNode(nodeId, pending)) {
      throw new Error(`Request ${requestId} does not belong to node ${nodeId}.`);
    }
    this.removePending(nodeId, requestId);
    this.rememberAcknowledgement(nodeId, requestId);
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
