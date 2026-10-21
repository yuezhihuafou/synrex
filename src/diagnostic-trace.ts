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
  | "conversation_labeled"
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
  conversationId?: string;
  conversationTitle?: string;
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
  "conversation_labeled",
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
  const conversationId = boundedString(fields.conversationId, /^conv_[a-f0-9]{32}$/);
  // Titles are opt-in and may be human-readable; never accept arbitrary
  // prompts, headers or long/multiline strings as diagnostic labels.
  const conversationTitle = boundedString(fields.conversationTitle, /^[^\x00-\x1f\x7f]{1,120}$/);
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
  if (conversationId) item.conversationId = conversationId;
  if (event === "conversation_labeled" && conversationId && conversationTitle) {
    item.conversationTitle = conversationTitle;
  }
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

  read(input: { minutes?: number; limit?: number; requestId?: string; conversationId?: string; title?: string } = {}): DiagnosticEntry[] {
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
          entries.push(entry);
        } catch { /* Ignore a truncated final line after a process interruption. */ }
      }
    }
    // Resolve an explicit title from retained label records before filtering.
    // A chat title is not a unique identity; matching titles can map to
    // multiple distinct opaque conversations.
    const matchedIds = input.title === undefined ? undefined : new Set(
      entries.filter((entry) => entry.conversationTitle === input.title && entry.conversationId)
        .map((entry) => entry.conversationId!),
    );
    return entries.filter((entry) => (
      (!input.requestId || entry.requestId === input.requestId)
      && (!input.conversationId || entry.conversationId === input.conversationId)
      && (!matchedIds || (entry.conversationId !== undefined && matchedIds.has(entry.conversationId)))
    )).slice(-limit);
  }
}

export function summarizeDiagnosticTrace(entries: DiagnosticEntry[]) {
  const requests = new Map<string, { requestId: string; lastEvent: DiagnosticEvent; conversationId?: string; tool?: string; callId?: string; status?: number; taskId?: string; runId?: string; lastAt: string }>();
  const conversationTitles = new Map<string, string>();
  for (const entry of entries) {
    if (entry.conversationId && entry.conversationTitle) {
      conversationTitles.set(entry.conversationId, entry.conversationTitle);
    }
    if (!entry.requestId) continue;
    const previous = requests.get(entry.requestId);
    requests.set(entry.requestId, {
      requestId: entry.requestId,
      lastEvent: entry.event,
      ...(entry.conversationId ?? previous?.conversationId
        ? { conversationId: entry.conversationId ?? previous?.conversationId } : {}),
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
    conversations: [...conversationTitles].map(([conversationId, conversationTitle]) => ({ conversationId, conversationTitle })),
    requests: [...requests.values()].map((request) => ({
      ...request,
      ...(request.conversationId && conversationTitles.has(request.conversationId)
        ? { conversationTitle: conversationTitles.get(request.conversationId) } : {}),
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
