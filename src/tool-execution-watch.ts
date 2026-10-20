import { randomUUID } from "node:crypto";

export type ToolExecutionEvent = "tool_execution_started" | "tool_execution_stalled" | "tool_execution_finished";
export type ToolExecutionLog = (
  level: "info" | "warn",
  event: ToolExecutionEvent,
  fields: Record<string, unknown>,
) => void;

/**
 * Observes MCP tool handler lifecycle without cancelling a possibly mutating
 * operation. Shell commands have their own durable execution lifecycle.
 */
export function watchToolExecution(input: {
  tool: string;
  workspaceId?: string;
  requestId?: string;
  emit: ToolExecutionLog;
  warnAfterMs?: number;
  repeatAfterMs?: number;
}): { finish(outcome: "ok" | "error", receipt?: { taskId?: string; runId?: string }): void } {
  const startedAt = performance.now();
  const callId = randomUUID();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase = 0;
  const fields = {
    callId,
    requestId: input.requestId,
    tool: input.tool,
    workspaceId: input.workspaceId,
  };
  input.emit("info", "tool_execution_started", fields);

  const arm = (delay: number) => {
    timer = setTimeout(() => {
      if (done) return;
      phase += 1;
      input.emit("warn", "tool_execution_stalled", {
        ...fields,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        note: "Tool handler has not returned; no cancellation was attempted",
      });
      arm(input.repeatAfterMs ?? 60_000);
    }, delay);
    timer.unref?.();
  };
  arm(input.warnAfterMs ?? 20_000);

  return {
    finish(outcome, receipt) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      input.emit("info", "tool_execution_finished", {
        ...fields,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
        stalled: phase > 0,
        ...(receipt?.taskId ? { taskId: receipt.taskId } : {}),
        ...(receipt?.runId ? { runId: receipt.runId } : {}),
      });
    },
  };
}
