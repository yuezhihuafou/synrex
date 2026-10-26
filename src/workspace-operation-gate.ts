/**
 * Process-local reader/writer admission by canonical physical checkout path.
 * This protects MCP file operations. Detached shells and external editors
 * remain outside its scope and must use isolated Git worktrees.
 */
export class WorkspaceOperationGate {
  private readonly gates = new Map<string, {
    writer: Promise<void>;
    readers: Set<Promise<void>>;
    pending: number;
  }>();

  async run<T>(
    root: string,
    mode: "read" | "write",
    operation: () => Promise<T>,
    onWait?: (durationMs: number) => void,
  ): Promise<T> {
    let gate = this.gates.get(root);
    if (!gate) {
      gate = { writer: Promise.resolve(), readers: new Set(), pending: 0 };
      this.gates.set(root, gate);
    }
    gate.pending += 1;
    const started = performance.now();
    const waitFor = mode === "read" ? gate.writer
      : Promise.all([gate.writer, ...gate.readers]).then(() => undefined);
    const execution = waitFor.then(() => {
      const waited = Math.max(0, Math.round(performance.now() - started));
      if (waited >= 5) {
        try { onWait?.(waited); } catch { /* Observability never blocks work. */ }
      }
      return operation();
    });
    const settled = execution.then(() => undefined, () => undefined);
    if (mode === "read") {
      gate.readers.add(settled);
      void settled.then(() => gate!.readers.delete(settled));
    } else {
      gate.readers.clear();
      gate.writer = settled;
    }
    try {
      return await execution;
    } finally {
      gate.pending -= 1;
      if (gate.pending === 0 && this.gates.get(root) === gate) this.gates.delete(root);
    }
  }
  get queuedRoots(): number { return this.gates.size; }
}
