import type { MonitorEvent } from "./events.js";

// Presentation-only contract. Collection and normalization belong to the
// existing diagnostic pipeline, not to the Console.
export interface TraceSpan {
  name: string;
  node: string | null;
  startedAt: string;
  offsetMs: number;
  durationMs: number;
  outcome: string;
}
export interface TraceView {
  requestId: string;
  traceId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalMs: number | null;
  status: string;
  spans: TraceSpan[];
  events: number;
  coverage: string;
}

export function buildTrace(requestId: string, events: MonitorEvent[]): TraceView {
  const rows = events.filter(e => e.requestId === requestId).sort((a, b) => a.ts.localeCompare(b.ts));
  const received = rows.find(e => e.event === "mcp_received");
  const finished = [...rows].reverse().find(e => e.event === "mcp_finished" || e.event === "mcp_failed" || e.event === "mcp_closed_early");
  const start = received?.ts ?? rows[0]?.ts ?? null;
  const end = finished?.ts ?? null;
  const origin = start ? Date.parse(start) : 0;
  const spans: TraceSpan[] = [];
  for (const e of rows) {
    if (e.event !== "stage_finished" || !e.stage || typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs) || e.durationMs < 0) continue;
    const started = Date.parse(e.ts) - e.durationMs;
    spans.push({ name: e.stage, node: e.nodeId ?? null, startedAt: new Date(started).toISOString(),
      offsetMs: start ? Math.max(0, started - origin) : 0, durationMs: e.durationMs, outcome: e.outcome ?? "unknown" });
    if (spans.length >= 100) break;
  }
  spans.sort((a, b) => a.offsetMs - b.offsetMs);
  return { requestId, traceId: rows.find(e => e.traceId)?.traceId ?? null, startedAt: start, finishedAt: end,
    totalMs: typeof finished?.durationMs === "number" ? finished.durationMs : start && end ? Math.max(0, Date.parse(end) - origin) : null,
    status: !finished ? "incomplete" : finished.event === "mcp_finished" && (finished.status ?? 200) < 400 &&
      !rows.some(e => e.event === "tool_execution_finished" && e.outcome === "error") ? "completed" : "error",
    spans, events: rows.length,
    coverage: "仅展示诊断系统已提供的阶段；并发阶段可能重叠。缺失的阶段和 ChatGPT 内部推理时间不可推断。" };
}
