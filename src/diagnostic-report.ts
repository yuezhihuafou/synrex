import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runStoreRoot } from "./compact-runtime/run-store.js";
import { sanitizeDiagnostic, type DiagnosticEntry } from "./diagnostic-trace.js";

export function readRunTrace(runId: string, root = runStoreRoot()): DiagnosticEntry[] {
  const m = /^run_(\d{4})(\d{2})(\d{2})\d{6}_[a-f0-9]{8}$/.exec(runId);
  if (!m) throw new Error("Invalid run identifier");
  const file = path.join(root, `${m[1]}-${m[2]}-${m[3]}`, runId, "trace.jsonl");
  try {
    if (statSync(file).size > 64 * 1024) return [];
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      if (!line) return [];
      try { const x = JSON.parse(line) as DiagnosticEntry;
        return [{ ...sanitizeDiagnostic(x.event, x as unknown as Record<string, unknown>), ts: x.ts }];
      } catch { return []; }
    });
  } catch { return []; }
}

export function diagnosticTimings(entries: DiagnosticEntry[]) {
  const groups = new Map<string, number[]>();
  for (const entry of entries) {
    const key = entry.event === "stage_finished" ? `stage:${entry.stage}`
      : entry.event === "tool_execution_finished" ? `tool:${entry.tool}`
        : ["mcp_finished", "mcp_body_ready", "task_finished"].includes(entry.event) ? entry.event : undefined;
    if (key && entry.durationMs !== undefined) {
      const values = groups.get(key) ?? [];
      values.push(entry.durationMs);
      groups.set(key, values);
    }
  }
  return [...groups].map(([name, values]) => {
    values.sort((a, b) => a - b);
    const q = (p: number) => values[Math.floor((values.length - 1) * p)]!;
    return { name, count: values.length, p50Ms: q(.5), p95Ms: q(.95), p99Ms: q(.99), maxMs: q(1) };
  });
}

/** Read-only adapter for external service/tunnel lifecycle. Never echo raw
 * journal messages, URLs or credentials into the diagnostic report. */
export function systemDiagnosticEvents(minutes: number) {
  const result = spawnSync("journalctl", ["--user", "-u", "devspace.service", "-u", "cloudflared-devspace.service",
    "--since", `${minutes} minutes ago`, "--no-pager", "-o", "json"], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { available: false, reason: "journal_unavailable", events: [] };
  const events: Array<{ ts: string; event: string; connection?: number }> = [];
  for (const line of result.stdout.split("\n")) {
    try {
      const entry = JSON.parse(line) as { MESSAGE?: string; __REALTIME_TIMESTAMP?: string };
      const m = entry.MESSAGE ?? "";
      const event = m.startsWith("Started devspace.service") ? "service_started"
        : m.startsWith("Stopped devspace.service") ? "service_stopped"
          : m.includes("Unable to reach the origin service") && !m.includes("failed to serve incoming request") ? "origin_unavailable"
            : m.includes("Registered tunnel connection") ? "tunnel_registered"
              : m.includes("Retrying connection") ? "tunnel_retry"
                : m.includes("Connection terminated") || m.includes("Serve tunnel error") ? "tunnel_disconnected" : undefined;
      const time = Number(entry.__REALTIME_TIMESTAMP) / 1000;
      if (!event || !Number.isFinite(time)) continue;
      const index = /connIndex=(\d+)/.exec(m);
      events.push({ ts: new Date(time).toISOString(), event, ...(index ? { connection: Number(index[1]) } : {}) });
    } catch { /* Partial journal entries do not invalidate a report. */ }
  }
  return { available: true, counts: Object.fromEntries([...new Set(events.map((x) => x.event))].map((event) => [event, events.filter((x) => x.event === event).length])),
    events: events.slice(-100), truncated: events.length > 100 };
}
