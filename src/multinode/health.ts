import type { ControlPlaneStore } from "./store.js";

export class NodeHealthMonitor {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly suspectAfterMs: number,
    private readonly offlineAfterMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    const cadence = Math.max(1_000, Math.min(10_000, Math.floor(this.suspectAfterMs / 3)));
    this.timer = setInterval(() => this.reconcile(), cadence);
    this.timer.unref?.();
    this.reconcile();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  reconcile(now = Date.now()): void {
    for (const node of this.store.listNodes()) {
      if (node.kind !== "remote" || node.health === "draining") continue;
      const seenAt = Date.parse(node.lastSeenAt);
      const age = Number.isFinite(seenAt) ? Math.max(0, now - seenAt) : Number.POSITIVE_INFINITY;
      const health = age >= this.offlineAfterMs
        ? "offline"
        : age >= this.suspectAfterMs
          ? "suspect"
          : "online";
      if (health !== node.health) this.store.setNodeHealth(node.id, health);
    }
  }
}
