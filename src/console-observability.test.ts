import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConsoleObservability } from "./console-observability.js";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

test("separates completed HTTP, early close, incomplete and unknown host state", () => {
  const entry = (requestId: string, event: DiagnosticEntry["event"], extra: Partial<DiagnosticEntry> = {}): DiagnosticEntry =>
    ({ ts: "2026-10-22T00:00:00Z", requestId, event, ...extra });
  const result = summarizeConsoleObservability([
    entry("a", "mcp_received", { inputBytes: 120 }),
    entry("a", "mcp_finished", { durationMs: 200, outputBytes: 300 }),
    entry("b", "mcp_finished", { durationMs: 50 }),
    entry("c", "mcp_closed_early"), entry("d", "tool_execution_finished"),
    entry("e", "mcp_received"), entry("f", "mcp_failed"),
  ]);
  assert.deepEqual(result.lifecycle, { httpCompleted: 2, closedEarly: 1, handlerFailed: 1, toolCompletedWithoutHttp: 1, unknown: 1 });
  assert.equal(result.latency.medianMs, 50);
  assert.equal(result.latency.p95Ms, 200);
  assert.equal(result.transfer.observedInputBytes, 120);
  assert.equal(result.coverage.tokenUsage, "unavailable");
  assert.equal(result.coverage.hostInference, "unobservable");
});

test("recent traffic measures actual recorded payload bytes per wall-clock second, never output tokens/s", () => {
  const now=Date.parse("2026-10-27T15:00:00Z");
  const entries: DiagnosticEntry[]=[
    {ts:"2026-10-27T14:59:12Z",event:"mcp_received",requestId:"r1",inputBytes:600},
    {ts:"2026-10-27T14:59:30Z",event:"mcp_finished",requestId:"r1",outputBytes:6000,durationMs:20000},
    {ts:"2026-10-27T14:58:00Z",event:"mcp_finished",requestId:"old",outputBytes:100000,durationMs:10},
  ];
  const live=summarizeConsoleObservability(entries,now);
  assert.equal(live.recentTraffic.inputBytesPerSecond,10);
  assert.equal(live.recentTraffic.outputBytesPerSecond,100);
  assert.equal(live.recentTraffic.measuredResponses,1);
  assert.equal(live.recentTraffic.lastObservedAt,"2026-10-27T14:59:30Z");
  const expired=summarizeConsoleObservability(entries,now+130_000);
  assert.equal(expired.recentTraffic.outputBytesPerSecond,null);
  assert.equal(expired.recentTraffic.inputBytesPerSecond,null);
});

test("measured tool tokens use a 60s wall-clock window with independent coverage and 10m trend", () => {
  const now=Date.parse("2026-10-27T15:00:00Z");
  const entries:DiagnosticEntry[]=[
    {ts:"2026-10-27T14:59:05Z",event:"mcp_body_ready",rpcMethod:"tools/call",requestId:"r",inputTokens:20},
    {ts:"2026-10-27T14:59:06Z",event:"tool_execution_started",requestId:"r",tool:"read"},
    {ts:"2026-10-27T14:59:40Z",event:"mcp_finished",requestId:"r",durationMs:3000,outputTokens:120},
    {ts:"2026-10-27T14:50:00Z",event:"mcp_body_ready",rpcMethod:"tools/call",requestId:"old",inputTokens:1000},
    {ts:"2026-10-27T14:50:01Z",event:"mcp_finished",requestId:"old",outputTokens:5000},
  ];
  const stats=summarizeConsoleObservability(entries,now);
  assert.equal(stats.tokens.outputTokensPerSecond,2);
  assert.equal(stats.tokens.inputTotal,1020);
  assert.equal(stats.tokens.outputTotal,5120);
  assert.equal(stats.tokens.measuredOutputs,2);
  assert.equal(stats.tokens.toolCallsPerMinute,1);
  assert.equal(stats.tokens.averageLatencyMs,3000);
  assert.equal(stats.tokens.trend.reduce((a,b)=>a+b.outputTokens,0),120);
  assert.equal(stats.coverage.tokenUsage,"o200k_base_tool_payload");
  assert.equal(summarizeConsoleObservability(entries,now+120000).tokens.outputTokensPerSecond,null);
});

test("asynchronous Token worker events contribute once per request without requiring synchronous payload counts",()=>{
  const now=Date.parse("2026-10-28T12:11:00Z");
  const events:DiagnosticEntry[]=[
    {event:"mcp_body_ready",ts:"2026-10-28T12:10:10Z",requestId:"r",rpcMethod:"tools/call"},
    {event:"tool_tokens_measured",ts:"2026-10-28T12:10:11Z",requestId:"r",inputTokens:42},
    {event:"mcp_finished",ts:"2026-10-28T12:10:13Z",requestId:"r",durationMs:500},
    {event:"tool_tokens_measured",ts:"2026-10-28T12:10:14Z",requestId:"r",outputTokens:300},
  ];
  const result=summarizeConsoleObservability(events,now);
  assert.equal(result.tokens.inputTotal,42);
  assert.equal(result.tokens.outputTotal,300);
  assert.equal(result.tokens.outputTokensPerSecond,5);
  assert.equal(result.tokens.measuredInputs,1);
  assert.equal(result.tokens.measuredOutputs,1);
});
