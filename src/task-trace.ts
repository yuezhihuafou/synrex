import { appendFileSync } from "node:fs";
import path from "node:path";
import { diagnosticRuntime, sanitizeDiagnostic, type DiagnosticEvent, type DiagnosticEntry } from "./diagnostic-trace.js";

export type TaskTraceContext = Pick<DiagnosticEntry, "requestId" | "traceId" | "callId" | "nodeRequestId" | "workspaceId">;

/** Each run has its own tiny append-only lifecycle file. Independent runners
 * never contend on the coordinator's rotating diagnostic file. Run retention
 * removes this file with the existing run directory. No command/output bytes. */
export function recordTaskTrace(runDir: string, event: DiagnosticEvent, fields: Record<string, unknown>): void {
  try {
    appendFileSync(path.join(runDir, "trace.jsonl"), JSON.stringify(sanitizeDiagnostic(event, {
      ...fields, ...diagnosticRuntime,
    })) + "\n", { mode: 0o600 });
  } catch { /* Task execution must survive unavailable diagnostics. */ }
}
