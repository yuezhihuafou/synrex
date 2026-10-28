import type { DiagnosticEntry } from "./diagnostic-trace.js";

export interface ConsoleObservability {
  coverage: { observedEvents: number; observedRequests: number; tokenUsage: "unavailable" | "o200k_base_tool_payload"; hostInference: "unobservable" };
  latency: { completed: number; medianMs: number | null; p95Ms: number | null; maximumMs: number | null };
  lifecycle: { httpCompleted: number; closedEarly: number; handlerFailed: number; toolCompletedWithoutHttp: number; unknown: number };
  transfer: { observedInputBytes: number; observedOutputBytes: number; approximateInputTokens: number | null; approximateOutputTokens: number | null };
  capacity: { inputP95: number | null; outputP95: number | null; largestOutput: number; largeResponses: number;
    /** @deprecated Use recentTraffic.outputBytesPerSecond with its explicit window and coverage. */
    bytesPerSecond: number | null };
  /** Observed MCP HTTP response payload bytes per wall-clock second, not model tokens/s or NIC link speed. */
  recentTraffic: { windowSeconds: 60; inputBytesPerSecond: number | null; outputBytesPerSecond: number | null;
    measuredResponses: number; lastObservedAt: string | null };
  /** o200k_base text-block counts, not GPT host inference tokens; only measured tool calls. */
  tokens: {
    encoding: "o200k_base"; windowSeconds: 60;
    inputTotal: number | null; outputTotal: number | null;
    measuredInputs: number; measuredOutputs: number;
    outputTokensPerSecond: number | null; toolCallsPerMinute: number | null;
    averageLatencyMs: number | null; lastObservedAt: string | null;
    trend: Array<{ minute: string; outputTokens: number; measuredOutputs: number }>;
  };
}

/** Summaries use only recorded observations, not inferred model-side events. */
export function summarizeConsoleObservability(events: DiagnosticEntry[], now = Date.now()): ConsoleObservability {
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
  let recentInputBytes=0, recentOutputBytes=0, recentResponses=0;
  let latestAt: string | null=null, latestMs=-Infinity;
  const start=now-60_000;
  let inputTokenTotal=0,outputTokenTotal=0,measuredInputs=0,measuredOutputs=0;
  let recentOutputTokens=0,recentOutputSamples=0,recentToolCalls=0;
  let recentToolDuration=0,recentToolDurations=0;
  const firstMinute=Math.floor(now/60000)-9;
  const trend=Array.from({length:10},(_,i)=>({
    minute:new Date((firstMinute+i)*60000).toISOString(),outputTokens:0,measuredOutputs:0,
  }));
  for (const entries of byRequest.values()) {
    const names = new Set(entries.map(e => e.event));
    if (names.has("mcp_finished")) lifecycle.httpCompleted++;
    else if (names.has("mcp_closed_early")) lifecycle.closedEarly++;
    else if (names.has("mcp_failed")) lifecycle.handlerFailed++;
    else if (names.has("tool_execution_finished")) lifecycle.toolCompletedWithoutHttp++;
    else lifecycle.unknown++;
    const finish = [...entries].reverse().find(e => e.event === "mcp_finished");
    const body=entries.find(e=>e.event==="mcp_body_ready" && e.rpcMethod==="tools/call");
    const toolStarted=entries.some(e=>e.event==="tool_execution_started");
    if (finish && typeof finish.durationMs === "number") durations.push(finish.durationMs);
    // One reading per request and direction; don't double-count stages.
    const input=entries.find(e => e.event === "mcp_received" && e.inputBytes !== undefined)?.inputBytes;
    const output=finish?.outputBytes;
    if(typeof input==="number" && input>=0){inputSizes.push(input);observedInputBytes+=input;}
    if(typeof output==="number" && output>=0){
      outputSizes.push(output);observedOutputBytes+=output;
    }
    if (body && typeof body.inputTokens==="number") {
      inputTokenTotal+=body.inputTokens;measuredInputs++;
    }
    if (finish && typeof finish.outputTokens==="number" && body) {
      outputTokenTotal+=finish.outputTokens;measuredOutputs++;
      const at=Date.parse(finish.ts);
      if (at>=start && at<=now) {recentOutputTokens+=finish.outputTokens;recentOutputSamples++;}
      const index=Math.floor(at/60000)-firstMinute;
      if(index>=0 && index<trend.length){
        trend[index]!.outputTokens+=finish.outputTokens;trend[index]!.measuredOutputs++;
      }
    }
    if (toolStarted) {
      const at=Date.parse(entries.find(e=>e.event==="tool_execution_started")!.ts);
      if(at>=start && at<=now) recentToolCalls++;
      if(finish && typeof finish.durationMs==="number" && Date.parse(finish.ts)>=start && Date.parse(finish.ts)<=now){
        recentToolDuration+=finish.durationMs;recentToolDurations++;
      }
    }
    // Attribute bytes to the timestamp where each boundary observed them;
    // do not divide by request duration (which includes model/tool idle time).
    // Use one boundary per request. Mirrored peer/OTel events may repeat stages.
    const received=entries.find(e=>e.event==="mcp_received" && typeof e.inputBytes==="number");
    for (const event of [received, finish].filter((e):e is DiagnosticEntry=>Boolean(e))) {
      const at=Date.parse(event.ts);
      if (!Number.isFinite(at) || at>now) continue;
      if(at>latestMs){latestMs=at;latestAt=event.ts;}
      if(at<start)continue;
      if(event.event==="mcp_received" && typeof event.inputBytes==="number" && event.inputBytes>=0)
        recentInputBytes+=event.inputBytes;
      if(event.event==="mcp_finished" && typeof event.outputBytes==="number" && event.outputBytes>=0){
        recentOutputBytes+=event.outputBytes;recentResponses++;
      }
    }
  }
  durations.sort((a,b) => a-b);
  inputSizes.sort((a,b)=>a-b);outputSizes.sort((a,b)=>a-b);
  const percentile = (p: number): number | null => durations.length ? durations[Math.ceil(p * durations.length)-1]! : null;
  const p95=(values:number[])=>values.length?values[Math.ceil(.95*values.length)-1]!:null;
  return {
    coverage: { observedEvents: events.length, observedRequests: byRequest.size, tokenUsage: measuredInputs||measuredOutputs?"o200k_base_tool_payload":"unavailable", hostInference: "unobservable" },
    latency: { completed: durations.length, medianMs: percentile(.5), p95Ms: percentile(.95), maximumMs: durations.at(-1) ?? null },
    lifecycle,
    transfer: { observedInputBytes, observedOutputBytes, approximateInputTokens: null, approximateOutputTokens: null },
    capacity: {inputP95:p95(inputSizes),outputP95:p95(outputSizes),largestOutput:outputSizes.at(-1)??0,
      largeResponses:outputSizes.filter(bytes=>bytes>16384).length,
      bytesPerSecond:latestMs>=start?Math.round(recentOutputBytes/60):null},
    recentTraffic: { windowSeconds:60,
      inputBytesPerSecond:latestMs>=start?Math.round(recentInputBytes/60):null,
      outputBytesPerSecond:latestMs>=start?Math.round(recentOutputBytes/60):null,
      measuredResponses:recentResponses, lastObservedAt:latestAt },
    tokens: { encoding:"o200k_base", windowSeconds:60,
      inputTotal:measuredInputs?inputTokenTotal:null,outputTotal:measuredOutputs?outputTokenTotal:null,
      measuredInputs,measuredOutputs,
      outputTokensPerSecond:recentOutputSamples?Math.round(recentOutputTokens/60*10)/10:null,
      toolCallsPerMinute:latestMs>=start?recentToolCalls:null,
      averageLatencyMs:recentToolDurations?Math.round(recentToolDuration/recentToolDurations):null,
      lastObservedAt:latestAt,trend },
  };
}
