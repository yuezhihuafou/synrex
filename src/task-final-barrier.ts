import type { DurableTaskView } from "./durable-task-model.js";

const ESCALATE_AFTER_MS = 60_000;
const MAX_SUGGESTED_BACKOFF_MS = 60_000;

export interface FinalBarrierReceipt {
  stage: "waiting" | "investigate" | "input_required" | "terminal";
  elapsedMs: number;
  nextCheckMs: number;
  runId: string;
  outputBytes: number;
  outputLines: number;
  idleMs: number;
  action: "wait_or_do_independent_work" | "inspect_logs_or_checkpoint"
    | "request_input_or_cancel" | "verify_result";
}

/** This is advisory cadence for the *last* dependent task. The actual
 * task_wait HTTP call stays <=10 seconds; the model should not spin rapidly
 * between calls, and unfinished work must never be reported as completed.
 */
export function finalBarrierReceipt(view: DurableTaskView, now = Date.now()): FinalBarrierReceipt {
  const createdAt = Date.parse(view.createdAt);
  const updatedAt = Date.parse(view.lastUpdatedAt);
  const elapsedMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
  const idleMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
  const terminal = view.status === "completed" || view.status === "failed"
    || view.status === "cancelled";
  const stage = view.status === "input_required" ? "input_required"
    : terminal ? "terminal" : elapsedMs >= ESCALATE_AFTER_MS ? "investigate" : "waiting";
  // Exponential backoff with a fixed bound: approximately 2, 4, 8 and 16 s
  // in successive 15-second periods; not an independent scheduling engine.
  const exponent = Math.min(5, Math.floor(elapsedMs / 15_000));
  return {
    stage,
    elapsedMs,
    idleMs,
    nextCheckMs: terminal || view.status === "input_required"
      ? 0 : Math.min(MAX_SUGGESTED_BACKOFF_MS, 2_000 * (2 ** exponent)),
    runId: view.runId,
    outputBytes: view.outputBytes,
    outputLines: view.outputLines,
    action: stage === "terminal" ? "verify_result"
      : stage === "input_required" ? "request_input_or_cancel"
      : stage === "investigate" ? "inspect_logs_or_checkpoint"
      : "wait_or_do_independent_work",
  };
}
