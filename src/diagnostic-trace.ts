import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";

// Two small fixed-size files. These are *diagnostics*, not command output logs.
// Never record MCP arguments, shell command text, OAuth headers or error messages.
export const DIAGNOSTIC_FILE_LIMIT = 1024 * 1024;
const DIAGNOSTIC_DIR = "diagnostics";
const DIAGNOSTIC_FILE = "recent.jsonl";

export type DiagnosticEvent =
  | "mcp_received"
  | "mcp_finished"
  | "mcp_closed_early"
  | "mcp_failed"
  | "tool_execution_started"
  | "tool_execution_stalled"
  | "tool_execution_finished";

export interface DiagnosticEntry {
  ts: string;
  event: DiagnosticEvent;
  requestId?: string;
  callId?: string;
  workspaceId?: string;
  tool?: string;
  durationMs?: number;
  elapsedMs?: number;
  status?: number;
  outcome?: string;
  phase?: number;
  taskId?: string;
  runId?: string;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,110}$/;
const SAFE_OUTCOME = /^(ok|error)$/;
const EVENT_NAMES: readonly string[] = [
  "mcp_received", "mcp_finished", "mcp_closed_early", "mcp_failed",
  "tool_execution_started", "tool_execution_stalled", "tool_execution_finished",
];

function boundedString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function boundedNumber(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

// Deliberately construct an allowlisted record rather than spreading arbitrary
// fields supplied by SDKs, which might contain prompt bodies or credentials.
export function sanitizeDiagnostic(event: DiagnosticEvent, fields: Record<string, unknown> = {}): DiagnosticEntry {
  if (!EVENT_NAMES.includes(event)) throw new Error("Unsupported diagnostic event");
  const item: DiagnosticEntry = { ts: new Date().toISOString(), event };
  const requestId = boundedString(fields.requestId, SAFE_ID);
  const callId = boundedString(fields.callId, SAFE_ID);
  const workspaceId = boundedString(fields.workspaceId, SAFE_ID);
  const tool = boundedString(fields.tool, /^[a-z][a-z0-9_-]{0,79}$/);
  const outcome = boundedString(fields.outcome, SAFE_OUTCOME);
  const taskId = boundedString(fields.taskId, /^task_[a-zA-Z0-9-]{1,80}$/);
  const runId = boundedString(fields.runId, /^run_[a-zA-Z0-9_-]{1,90}$/);
  const durationMs = boundedNumber(fields.durationMs, 365 * 24 * 3600 * 1000);
  const elapsedMs = boundedNumber(fields.elapsedMs, 365 * 24 * 3600 * 1000);
  const status = boundedNumber(fields.status, 599);
  const phase = boundedNumber(fields.phase, 100_000);
  if (requestId) item.requestId = requestId;
  if (callId) item.callId = callId;
  if (workspaceId) item.workspaceId = workspaceId;
  if (tool) item.tool = tool;
  if (outcome) item.outcome = outcome;
  if (taskId) item.taskId = taskId;
  if (runId) item.runId = runId;
  if (durationMs !== undefined) item.durationMs = durationMs;
  if (elapsedMs !== undefined) item.elapsedMs = elapsedMs;
  if (status !== undefined) item.status = status;
  if (phase !== undefined) item.phase = phase;
  return item;
}

export class DiagnosticTrace {
  readonly file: string;
  readonly previousFile: string;
  private warned = false;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, DIAGNOSTIC_DIR, DIAGNOSTIC_FILE);
    this.previousFile = this.file + ".1";
  }

  record(event: DiagnosticEvent, fields: Record<string, unknown> = {}): void {
    try {
      const entry = sanitizeDiagnostic(event, fields);
      const line = JSON.stringify(entry) + "\n";
      const dir = path.dirname(this.file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > DIAGNOSTIC_FILE_LIMIT) {
        renameSync(this.file, this.previousFile);
      }
      appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.file, 0o600);
      this.warned = false;
    } catch (error) {
      // Diagnostics must never break code execution or authenticated requests.
      if (!this.warned) {
        this.warned = true;
        console.warn("Synrex diagnostic trace unavailable:", error instanceof Error ? error.name : "unknown");
      }
    }
  }

  read(input: { minutes?: number; limit?: number; requestId?: string } = {}): DiagnosticEntry[] {
    const minutes = Math.min(Math.max(input.minutes ?? 30, 1), 24 * 60);
    const limit = Math.min(Math.max(input.limit ?? 70, 1), 200);
    const cutoff = Date.now() - minutes * 60_000;
    const entries: DiagnosticEntry[] = [];
    for (const file of [this.previousFile, this.file]) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as DiagnosticEntry;
          if (!EVENT_NAMES.includes(entry.event) || Date.parse(entry.ts) < cutoff) continue;
          if (input.requestId && entry.requestId !== input.requestId) continue;
          entries.push(entry);
        } catch { /* Ignore a truncated final line after a process interruption. */ }
      }
    }
    return entries.slice(-limit);
  }
}

export function summarizeDiagnosticTrace(entries: DiagnosticEntry[]) {
  const requests = new Map<string, { requestId: string; lastEvent: DiagnosticEvent; tool?: string; callId?: string; status?: number; taskId?: string; runId?: string; lastAt: string }>();
  for (const entry of entries) {
    if (!entry.requestId) continue;
    const previous = requests.get(entry.requestId);
    requests.set(entry.requestId, {
      requestId: entry.requestId,
      lastEvent: entry.event,
      tool: entry.tool ?? previous?.tool,
      callId: entry.callId ?? previous?.callId,
      status: entry.status ?? previous?.status,
      taskId: entry.taskId ?? previous?.taskId,
      runId: entry.runId ?? previous?.runId,
      lastAt: entry.ts,
    });
  }
  return {
    note: "If tool and HTTP finished, Synrex returned; this cannot diagnose ChatGPT model/UI continuation.",
    requests: [...requests.values()].map((request) => ({
      ...request,
      classification: request.lastEvent === "mcp_finished"
        ? "rev_http_completed"
        : request.lastEvent === "mcp_closed_early"
          ? "connection_closed_early"
          : request.lastEvent === "mcp_failed"
            ? "rev_handler_error"
            : request.lastEvent === "tool_execution_finished"
              ? "tool_finished_http_not_observed"
              : "rev_incomplete_or_log_window_truncated",
    })),
  };
}
