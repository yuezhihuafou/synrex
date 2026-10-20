import type { DurableTaskView } from "./durable-task-model.js";

const DEFAULT_WAIT_MS = 8_000;
const MAX_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 300;
const MAX_POLL_MS = 2_500;

type SubscribeToChanges = (onChange: () => void) => () => void;

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
  options: {
    waitMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    /** Local task.json changes wake the wait immediately; a timed safety read
     * remains mandatory because filesystem watch events can be dropped. */
    subscribe?: SubscribeToChanges;
  } = {},
): Promise<TaskWaitResult> {
  const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, options.waitMs ?? DEFAULT_WAIT_MS));
  let pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const startedAt = Date.now();
  let notified = false;
  let wake: (() => void) | undefined;
  // Install watch before the first read to avoid losing an atomic rename
  // between reading the state and registering an event listener.
  const unsubscribe = options.subscribe?.(() => {
    notified = true;
    wake?.();
  }) ?? (() => undefined);
  try {
    let view = await read();
    const baseline = sinceRevision ?? view.revision;
    if (terminal(view) || view.revision !== baseline) return { view, unchanged: false };
    while (Date.now() - startedAt < waitMs) {
      const remaining = waitMs - (Date.now() - startedAt);
      if (!notified) {
        await new Promise<void>((resolve, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason ?? new Error("Task wait aborted"));
            return;
          }
          let timer: ReturnType<typeof setTimeout>;
          const finish = () => {
            clearTimeout(timer);
            wake = undefined;
            options.signal?.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            clearTimeout(timer);
            wake = undefined;
            options.signal?.removeEventListener("abort", abort);
            reject(options.signal?.reason ?? new Error("Task wait aborted"));
          };
          wake = finish;
          options.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(finish, Math.min(remaining, pollMs));
          if (notified) finish();
        });
      }
      notified = false;
      view = await read();
      if (terminal(view) || view.revision !== baseline) return { view, unchanged: false };
      // Bounded backoff + jitter for safety reads: low initial latency without
      // a permanent 500ms read loop or synchronised polling bursts.
      pollMs = Math.min(MAX_POLL_MS, Math.ceil(pollMs * (1.6 + 0.2 * Math.random())));
    }
    return { view, unchanged: true };
  } finally {
    unsubscribe();
  }
}
