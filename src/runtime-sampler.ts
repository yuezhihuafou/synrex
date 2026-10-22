import type { DiagnosticTrace } from "./diagnostic-trace.js";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";

/** Per-process metadata only; an unavailable diagnostics disk cannot stop MCP. */
export function startRuntimeSampler(
  diagnostics: Pick<DiagnosticTrace, "record">, activeToolCount: () => number = () => 0,
  intervalMs = 10_000,
): () => void {
  let next = performance.now() + intervalMs;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let gcCount = 0;
  let gcDurationMs = 0;
  const gc = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcDurationMs += entry.duration;
    }
  });
  try { gc.observe({ entryTypes: ["gc"] }); } catch { /* Optional Node runtime metric. */ }
  let utilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now();
    try {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const currentUtilization = performance.eventLoopUtilization();
      const loopLoad = performance.eventLoopUtilization(currentUtilization, utilization);
      utilization = currentUtilization;
      diagnostics.record("runtime_sampled", {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        eventLoopLagMs: Math.round(Math.max(0, now - next)),
        eventLoopP95Ms: Math.round(lag.percentile(95) / 1e6),
        eventLoopUtilizationPermille: Math.round(loopLoad.utilization * 1000),
        gcCount, gcDurationMs: Math.round(gcDurationMs),
        activeToolCount: activeToolCount(),
      });
    } catch { /* Never propagate observability failures. */ }
    next = now + intervalMs;
    gcCount = 0; gcDurationMs = 0; lag.reset();
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); lag.disable(); gc.disconnect(); };
}
