import type { DiagnosticEntry } from "./diagnostic-trace.js";

export interface ConsoleObservability {
  coverage: { observedEvents: number; observedRequests: number; tokenUsage: "unavailable"; hostInference: "unobservable" };
  latency: { completed: number; medianMs: number | null; p95Ms: number | null; maximumMs: number | null };
  lifecycle: { httpCompleted: number; closedEarly: number; handlerFailed: number; toolCompletedWithoutHttp: number; unknown: number };
  transfer: { observedInputBytes: number; observedOutputBytes: number; approximateInputTokens: number | null; approximateOutputTokens: number | null };
}

/** Summaries use only recorded observations, not inferred model-side events. */
export function summarizeConsoleObservability(events: DiagnosticEntry[]): ConsoleObservability {
  const byRequest = new Map<string, DiagnosticEntry[]>();
  for (const event of events) {
    const id = event.traceId ?? event.requestId;
    if (!id) continue;
    const list = byRequest.get(id) ?? [];
    list.push(event);
    byRequest.set(id, list);
  }
  const durations: number[] = [];
  const lifecycle = { httpCompleted: 0, closedEarly: 0, handlerFailed: 0, toolCompletedWithoutHttp: 0, unknown: 0 };
  let observedInputBytes = 0;
  let observedOutputBytes = 0;
  for (const entries of byRequest.values()) {
    const names = new Set(entries.map(e => e.event));
    if (names.has("mcp_finished")) lifecycle.httpCompleted++;
    else if (names.has("mcp_closed_early")) lifecycle.closedEarly++;
    else if (names.has("mcp_failed")) lifecycle.handlerFailed++;
    else if (names.has("tool_execution_finished")) lifecycle.toolCompletedWithoutHttp++;
    else lifecycle.unknown++;
    const finish = [...entries].reverse().find(e => e.event === "mcp_finished");
    if (finish && typeof finish.durationMs === "number") durations.push(finish.durationMs);
    // One reading per request and direction; don't double-count stages.
    observedInputBytes += entries.find(e => e.event === "mcp_received" && e.inputBytes !== undefined)?.inputBytes ?? 0;
    observedOutputBytes += entries.find(e => e.event === "mcp_finished" && e.outputBytes !== undefined)?.outputBytes ?? 0;
  }
  durations.sort((a,b) => a-b);
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length)-1]! : null;
  return {
    coverage: { observedEvents: events.length, observedRequests: byRequest.size, tokenUsage: "unavailable", hostInference: "unobservable" },
    latency: { completed: durations.length, medianMs: percentile(.5), p95Ms: percentile(.95), maximumMs: durations.at(-1) ?? null },
    lifecycle,
    transfer: { observedInputBytes, observedOutputBytes, approximateInputTokens: null, approximateOutputTokens: null },
  };
}
