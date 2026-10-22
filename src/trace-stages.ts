import { currentRequestLogContext } from "./logger.js";
import type { DiagnosticEvent } from "./diagnostic-trace.js";
import { childOtelContext } from "./otel-context.js";
import { runWithRequestLogContext } from "./logger.js";
import { emitNativeSpan } from "./native-otel.js";

export function errorCategory(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (value?.code === "ENOENT") return "not_found";
  if (value?.code === "EACCES" || value?.code === "EPERM") return "permission";
  if (value?.name === "AbortError" || value?.name === "TimeoutError") return "timeout";
  const message = typeof value?.message === "string" ? value.message : "";
  if (/^Invalid patch:/.test(message)) return "invalid_input";
  if (/indeterminate|interrupted after/i.test(message)) return "indeterminate";
  if (/offline|unavailable|did not complete request/i.test(message)) return "transport";
  return "internal";
}

/** Metadata only. Diagnostics must not change the outcome of primary work. */
export function traceEvent(event: DiagnosticEvent, fields: Record<string, unknown> = {}): void {
  const context = currentRequestLogContext();
  try {
    context?.emitDiagnostic?.(event, {
      requestId: context.requestId, traceId: context.traceId ?? context.requestId,
      callId: context.callId, nodeRequestId: context.nodeRequestId,
      otelTraceId: context.otelTraceId, otelSpanId: context.otelSpanId,
      otelParentSpanId: context.otelParentSpanId, ...fields,
    });
  } catch { /* Observational only. */ }
}

export async function traceStage<T>(stage: string, operation: () => T | Promise<T>, fields: Record<string, unknown> = {}): Promise<T> {
  const parent = currentRequestLogContext();
  const child = parent?.otelTraceId && parent.otelSpanId
    ? childOtelContext({ otelTraceId: parent.otelTraceId, otelSpanId: parent.otelSpanId }) : undefined;
  const execute = async () => {
    const started = performance.now();
    const wallStart = Date.now();
    traceEvent("stage_started", { ...fields, stage });
    try {
      const result = await operation();
      traceEvent("stage_finished", { ...fields, stage, outcome: "ok", durationMs: Math.round(performance.now() - started) });
      if (child) emitNativeSpan({ name: stage, context: child,
        startMs: wallStart, endMs: Date.now(), status: "ok",
        fields: { "synrex.request_id": parent?.requestId, "synrex.stage": stage } });
      return result;
    } catch (error) {
      traceEvent("stage_finished", { ...fields, stage, outcome: "error", errorCategory: errorCategory(error), durationMs: Math.round(performance.now() - started) });
      if (child) emitNativeSpan({ name: stage, context: child,
        startMs: wallStart, endMs: Date.now(), status: "error",
        fields: { "synrex.request_id": parent?.requestId, "synrex.stage": stage } });
      throw error;
    }
  };
  return parent && child ? runWithRequestLogContext({ ...parent, ...child }, execute) : execute();
}
