import { setTimeout as delay } from "node:timers/promises";
import type { DurableTaskView } from "./durable-task-model.js";

const DEFAULT_WAIT_MS = 8_000;
const MAX_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 500;

export interface TaskWaitResult {
  view: DurableTaskView;
  unchanged: boolean;
}

function terminal(view: DurableTaskView): boolean {
  return view.status === "completed" || view.status === "failed" || view.status === "cancelled"
    || view.status === "input_required";
}

/**
 * Bound a single MCP status wait; never start or replay an existing command.
 * The optional revision is the caller's last observed semantic task state.
 * No revision means "wait for a change from the state seen at call start".
 */
export async function waitForTaskChange(
  read: () => Promise<DurableTaskView>,
  sinceRevision?: string,
  options: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<TaskWaitResult> {
  const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, options.waitMs ?? DEFAULT_WAIT_MS));
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const startedAt = Date.now();
  let view = await read();
  const baseline = sinceRevision ?? view.revision;
  if (terminal(view) || view.revision !== baseline) return { view, unchanged: false };

  while (Date.now() - startedAt < waitMs) {
    const remaining = waitMs - (Date.now() - startedAt);
    await delay(Math.min(pollMs, remaining), undefined, { signal: options.signal });
    view = await read();
    if (terminal(view) || view.revision !== baseline) {
      return { view, unchanged: false };
    }
  }
  return { view, unchanged: true };
}
