import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sanitizeDiagnostic, type DiagnosticEntry } from "./diagnostic-trace.js";

export interface PeerSnapshot {
  coverage: "current" | "stale" | "unavailable";
  updatedAt?: string;
  events: DiagnosticEntry[];
}

export function readPeerSnapshot(stateDir: string, now = Date.now()): PeerSnapshot {
  const dir = path.join(stateDir, "observability", "peers");
  const statusFile = path.join(dir, "gateway.status.json");
  if (!existsSync(statusFile)) return { coverage: "unavailable", events: [] };
  try {
    if (statSync(statusFile).size > 2048) return { coverage: "unavailable", events: [] };
    const state = JSON.parse(readFileSync(statusFile, "utf8")) as { updatedAt?: unknown };
    const updatedAt = typeof state.updatedAt === "string" ? state.updatedAt : "";
    const age = now - Date.parse(updatedAt);
    if (!Number.isFinite(age) || age < -15_000) return { coverage: "unavailable", events: [] };
    const events: DiagnosticEntry[] = [];
    for (const file of ["gateway.diagnostics.jsonl", "gateway.network.jsonl"]) {
      const full = path.join(dir, file);
      if (!existsSync(full) || statSync(full).size > 768 * 1024) continue;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line || line.length > 4096) continue;
        try {
          const data = JSON.parse(line) as DiagnosticEntry;
          if (!Number.isFinite(Date.parse(data.ts))) continue;
          const entry = sanitizeDiagnostic(data.event, { ...data, nodeId: "gateway" });
          entry.ts = data.ts;
          events.push(entry);
        } catch { /* Ignore invalid lines. */ }
      }
    }
    return { coverage: age <= 120_000 ? "current" : "stale",
      updatedAt, events: events.slice(-1000) };
  } catch { return { coverage: "unavailable", events: [] }; }
}
