import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Two bounded files (16 MiB total). These are diagnostics, not command output logs.
// Never record MCP arguments, shell command text, OAuth headers or error messages.
export const DIAGNOSTIC_FILE_LIMIT = 8 * 1024 * 1024;
const BOOT_ID = randomUUID();
export const diagnosticRuntime = {
  bootId: BOOT_ID, pid: process.pid,
  revision: (() => { try {
    const value = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as { revision?: unknown };
    return typeof value.revision === "string" && /^[a-f0-9]{40}$/.test(value.revision) ? value.revision : undefined;
  } catch { return undefined; } })(),
};
const DIAGNOSTIC_DIR = "diagnostics";
const DIAGNOSTIC_FILE = "recent.jsonl";

export type DiagnosticEvent =
  | "stage_started" | "stage_finished" | "mcp_body_ready" | "mcp_headers_sent"
  | "request_stalled" | "runtime_started" | "runtime_stopping"
  | "runtime_sampled"
  | "network_sampled" | "tunnel_registered" | "tunnel_disconnected" | "tunnel_retry" | "tunnel_auth_failed"
  | "collector_sampled"
  | "origin_unavailable" | "service_started" | "service_stopped"
  | "node_queued" | "node_delivered" | "node_completed" | "node_peer_received" | "node_peer_started" | "node_peer_finished" | "node_peer_acknowledged" | "node_transport"
  | "task_created" | "task_runner_started" | "task_spawned" | "task_first_output" | "task_finished" | "task_notification"
  | "mailbox_registered" | "mailbox_delivered" | "mailbox_acknowledged" | "mailbox_error" | "learning_error"
  | "conversation_labeled"
  | "conversation_seen"
  | "node_request_timeout"
  | "node_late_completion"
  | "mcp_received"
  | "mcp_handler_returned"
  | "mcp_stream_closed"
  | "mcp_finished"
  | "mcp_closed_early"
  | "mcp_failed"
  | "tool_execution_started"
  | "tool_execution_stalled"
  | "tool_execution_finished";

export interface DiagnosticEntry {
  traceId?: string;
  otelTraceId?: string;
  otelSpanId?: string;
  otelParentSpanId?: string;
  nodeRequestId?: string;
  nodeId?: string;
  bootId?: string;
  revision?: string;
  pid?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  cpuUserMicros?: number;
  cpuSystemMicros?: number;
  eventLoopLagMs?: number;
  eventLoopP95Ms?: number;
  eventLoopUtilizationPermille?: number;
  gcDurationMs?: number;
  gcCount?: number;
  activeToolCount?: number;
  otelSpanPending?: number;
  otelSpanDropped?: number;
  tcpConnections?: number;
  tcpRttP50Ms?: number;
  tcpRttP95Ms?: number;
  tcpRetransSockets?: number;
  tcpRetransSegmentsTotal?: number;
  collectorRefusedLogRecords?: number;
  collectorRefusedMetricPoints?: number;
  collectorExporterFailed?: number;
  tunnelUnit?: string;
  stage?: string;
  rpcMethod?: string;
  rpcIdHash?: string;
  edgeRay?: string;
  errorCategory?: string;
  errorCode?: string;
  inputBytes?: number;
  outputBytes?: number;
  queuedMs?: number;
  exitCode?: number;
  signal?: string;
  ts: string;
  event: DiagnosticEvent;
  requestId?: string;
  callId?: string;
  workspaceId?: string;
  conversationId?: string;
  conversationTitle?: string;
  tool?: string;
  method?: string;
  responseMode?: string;
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
const SAFE_NODE_OUTCOME = /^(ok|error|indeterminate_after_dispatch|not_dispatched|completed_after_host_timeout)$/;
const EVENT_NAMES: readonly string[] = [
  "stage_started", "stage_finished", "mcp_body_ready", "mcp_headers_sent",
  "request_stalled", "runtime_started", "runtime_stopping",
  "runtime_sampled",
  "network_sampled", "tunnel_registered", "tunnel_disconnected", "tunnel_retry", "tunnel_auth_failed",
  "collector_sampled",
  "origin_unavailable", "service_started", "service_stopped",
  "node_queued", "node_delivered", "node_completed", "node_peer_received", "node_peer_started", "node_peer_finished", "node_peer_acknowledged", "node_transport",
  "task_created", "task_runner_started", "task_spawned", "task_first_output", "task_finished", "task_notification",
  "mailbox_registered", "mailbox_delivered", "mailbox_acknowledged", "mailbox_error", "learning_error",
  "conversation_labeled", "conversation_seen", "node_request_timeout", "node_late_completion",
  "mcp_received", "mcp_handler_returned", "mcp_stream_closed", "mcp_finished", "mcp_closed_early", "mcp_failed",
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
  const patterns: Partial<Record<keyof DiagnosticEntry, RegExp>> = {
    traceId: SAFE_ID, nodeRequestId: SAFE_ID, nodeId: SAFE_ID, bootId: SAFE_ID,
    otelTraceId: /^(?!0{32}$)[0-9a-f]{32}$/,
    otelSpanId: /^(?!0{16}$)[0-9a-f]{16}$/,
    otelParentSpanId: /^(?!0{16}$)[0-9a-f]{16}$/,
    revision: /^[a-f0-9]{40}$/,
    stage: /^(body|auth|mcp_dispatch|routing|tool_handler|learning|mailbox|result_packaging|task_launch|task_initial_wait|peer_execute|peer_ack)$/,
    rpcMethod: /^(initialize|notifications\/initialized|notifications\/cancelled|tools\/call|tools\/list|resources\/list|resources\/read|resources\/templates\/list|prompts\/list|prompts\/get|ping|unknown|batch)$/,
    rpcIdHash: /^[a-f0-9]{24}$/, edgeRay: /^[a-fA-F0-9]{8,32}(?:-[A-Za-z]{3})?$/,
    errorCategory: /^(not_found|permission|timeout|invalid_input|indeterminate|transport|internal|tool_error|command_exit|cancelled|auth|protocol)$/,
    errorCode: /^(ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ABORT_ERR|EPIPE|ERR_STREAM_PREMATURE_CLOSE)$/,
    signal: /^SIG(?:TERM|KILL|INT|ABRT|SEGV|HUP|PIPE)$/,
    tunnelUnit: /^(?:devspace|cloudflared|synrex)[a-zA-Z0-9_.-]{0,100}\.service$|^unknown$/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const value = boundedString(fields[key], pattern!);
    if (value) (item as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of ["pid", "inputBytes", "outputBytes", "queuedMs",
    "rssBytes", "heapUsedBytes", "cpuUserMicros", "cpuSystemMicros", "eventLoopLagMs",
    "eventLoopP95Ms", "eventLoopUtilizationPermille", "gcDurationMs", "gcCount", "activeToolCount",
    "otelSpanPending", "otelSpanDropped"] as const) {
    const value = boundedNumber(fields[key], Number.MAX_SAFE_INTEGER);
    if (value !== undefined) item[key] = value;
  }
  if (typeof fields.exitCode === "number" && Number.isInteger(fields.exitCode) && fields.exitCode >= -1 && fields.exitCode <= 65535) item.exitCode = fields.exitCode;
  const requestId = boundedString(fields.requestId, SAFE_ID);
  const callId = boundedString(fields.callId, SAFE_ID);
  const workspaceId = boundedString(fields.workspaceId, SAFE_ID);
  const conversationId = boundedString(fields.conversationId, /^conv_[a-f0-9]{32}$/);
  // Titles are opt-in and may be human-readable; never accept arbitrary
  // prompts, headers or long/multiline strings as diagnostic labels.
  const conversationTitle = boundedString(fields.conversationTitle, /^[^\x00-\x1f\x7f]{1,120}$/);
  const tool = boundedString(fields.tool, /^[a-z][a-z0-9_-]{0,79}$/);
  const method = boundedString(fields.method, /^(GET|POST|DELETE|OPTIONS)$/);
  const responseMode = boundedString(fields.responseMode, /^(sse|json|unknown)$/);
  const outcome = boundedString(fields.outcome, event.startsWith("node_") ? SAFE_NODE_OUTCOME : SAFE_OUTCOME);
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
  if (event === "conversation_labeled" && (conversationId || requestId) && conversationTitle) {
    item.conversationTitle = conversationTitle;
  }
  if (tool) item.tool = tool;
  if (method) item.method = method;
  if (responseMode) item.responseMode = responseMode;
  if (outcome) item.outcome = outcome;
  if (taskId) item.taskId = taskId;
  if (runId) item.runId = runId;
  if (durationMs !== undefined) item.durationMs = durationMs;
  if (elapsedMs !== undefined) item.elapsedMs = elapsedMs;
  if (status !== undefined) item.status = status;
  for (const key of ["tcpConnections", "tcpRttP50Ms", "tcpRttP95Ms",
    "tcpRetransSockets", "tcpRetransSegmentsTotal",
    "collectorRefusedLogRecords", "collectorRefusedMetricPoints", "collectorExporterFailed"] as const) {
    const n = boundedNumber(fields[key], Number.MAX_SAFE_INTEGER);
    if (n !== undefined) item[key] = n;
  }
  if (phase !== undefined) item.phase = phase;
  return item;
}

export class DiagnosticTrace {
  readonly file: string;
  readonly previousFile: string;
  private warned = false;

  constructor(stateDir: string, private readonly fileLimit = DIAGNOSTIC_FILE_LIMIT) {
    this.file = path.join(stateDir, DIAGNOSTIC_DIR, DIAGNOSTIC_FILE);
    this.previousFile = this.file + ".1";
  }

  record(event: DiagnosticEvent, fields: Record<string, unknown> = {}): void {
    try {
      const entry = sanitizeDiagnostic(event, { ...diagnosticRuntime, ...fields });
      const line = JSON.stringify(entry) + "\n";
      const dir = path.dirname(this.file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.fileLimit) {
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
    const limit = Math.min(Math.max(input.limit ?? 70, 1), 20_000);
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
    const matchedRequests = input.title === undefined ? undefined : new Set(
      entries.filter((entry) => entry.event==="conversation_labeled"
        && entry.conversationTitle===input.title && entry.requestId)
        .map((entry)=>entry.requestId!),
    );
    return entries.filter((entry) => (
      (!input.requestId || entry.requestId === input.requestId || entry.traceId === input.requestId || entry.nodeRequestId === input.requestId)
      && (!input.conversationId || entry.conversationId === input.conversationId)
      && (!matchedIds || (entry.conversationId !== undefined && matchedIds.has(entry.conversationId))
        || (entry.requestId!==undefined && matchedRequests?.has(entry.requestId)))
    )).slice(-limit);
  }
}

export function summarizeDiagnosticTrace(entries: DiagnosticEntry[]) {
  const observed = new Map<string, Set<DiagnosticEvent>>();
  const requests = new Map<string, { requestId: string; lastEvent: DiagnosticEvent; conversationId?: string; tool?: string; callId?: string; status?: number; taskId?: string; runId?: string; lastAt: string }>();
  const conversationTitles = new Map<string, string>();
  const requestTitles = new Map<string, string>();
  for (const entry of entries) {
    if (entry.conversationId && entry.conversationTitle) {
      conversationTitles.set(entry.conversationId, entry.conversationTitle);
    }
    if (entry.event === "conversation_labeled" && entry.requestId && entry.conversationTitle) {
      requestTitles.set(entry.requestId, entry.conversationTitle);
    }
    const id = entry.traceId ?? entry.requestId;
    if (!id) continue;
    const seen = observed.get(id) ?? new Set<DiagnosticEvent>();
    seen.add(entry.event);
    observed.set(id, seen);
    const previous = requests.get(id);
    requests.set(id, {
      requestId: id,
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
      ...(requestTitles.has(request.requestId)
        ? { conversationTitle: requestTitles.get(request.requestId) }
        : request.conversationId && conversationTitles.has(request.conversationId)
          ? { conversationTitle: conversationTitles.get(request.conversationId) } : {}),
      classification: observed.get(request.requestId)?.has("mcp_finished")
        ? "rev_http_completed"
        : observed.get(request.requestId)?.has("mcp_closed_early")
          ? "connection_closed_early"
          : observed.get(request.requestId)?.has("mcp_failed")
            ? "rev_handler_error"
            : observed.get(request.requestId)?.has("tool_execution_finished")
              ? "tool_finished_http_not_observed"
              : "rev_incomplete_or_log_window_truncated",
    })),
  };
}
