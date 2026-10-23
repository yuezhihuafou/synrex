import type { DiagnosticEntry } from "./diagnostic-trace.js";

export interface ConsoleObservability {
  coverage: { observedEvents: number; observedRequests: number; tokenUsage: "unavailable"; hostInference: "unobservable" };
  latency: { completed: number; medianMs: number | null; p95Ms: number | null; maximumMs: number | null };
  lifecycle: { httpCompleted: number; closedEarly: number; handlerFailed: number; toolCompletedWithoutHttp: number; unknown: number };
  transfer: { observedInputBytes: number; observedOutputBytes: number; approximateInputTokens: number | null; approximateOutputTokens: number | null };
  capacity: { inputP95: number | null; outputP95: number | null; largestOutput: number; largeResponses: number; bytesPerSecond: number | null };
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
  const inputSizes:number[]=[];
  const outputSizes:number[]=[];
  let timedBytes=0;
  let timedMs=0;
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
    const input=entries.find(e => e.event === "mcp_received" && e.inputBytes !== undefined)?.inputBytes;
    const output=finish?.outputBytes;
    if(typeof input==="number" && input>=0){inputSizes.push(input);observedInputBytes+=input;}
    if(typeof output==="number" && output>=0){
      outputSizes.push(output);observedOutputBytes+=output;
      if(typeof finish?.durationMs==="number" && finish.durationMs>0){timedBytes+=output;timedMs+=finish.durationMs;}
    }
  }
  durations.sort((a,b) => a-b);
  inputSizes.sort((a,b)=>a-b);outputSizes.sort((a,b)=>a-b);
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length)-1]! : null;
  const p95=(values:number[])=>values.length?values[Math.ceil(.95*values.length)-1]!:null;
  return {
    coverage: { observedEvents: events.length, observedRequests: byRequest.size, tokenUsage: "unavailable", hostInference: "unobservable" },
    latency: { completed: durations.length, medianMs: percentile(.5), p95Ms: percentile(.95), maximumMs: durations.at(-1) ?? null },
    lifecycle,
    transfer: { observedInputBytes, observedOutputBytes, approximateInputTokens: null, approximateOutputTokens: null },
    capacity: {inputP95:p95(inputSizes),outputP95:p95(outputSizes),largestOutput:outputSizes.at(-1)??0,
      largeResponses:outputSizes.filter(bytes=>bytes>16384).length,bytesPerSecond:timedMs>0?Math.round(timedBytes*1000/timedMs):null},
  };
}
