import { sanitizeDiagnostic } from "../diagnostic-trace.js";
import type { DiagnosticEntry } from "../diagnostic-trace.js";

// Monitor-side adapter for the additive full-chain trace contract. The running
// core and its logger are intentionally untouched.
export interface MonitorEvent extends Omit<DiagnosticEntry, "event"> {
  event: string;
  traceId?: string;
  nodeRequestId?: string;
  nodeId?: string;
  bootId?: string;
  revision?: string;
  stage?: string;
  rpcMethod?: string;
  errorCategory?: string;
  errorCode?: string;
  pid?: number;
  inputBytes?: number;
  outputBytes?: number;
  queuedMs?: number;
  exitCode?: number;
  signal?: string;
}
const additional = new Set([
  "stage_started", "stage_finished", "mcp_body_ready", "mcp_headers_sent", "request_stalled", "runtime_started", "runtime_stopping",
  "node_queued", "node_delivered", "node_completed", "node_peer_received", "node_peer_started", "node_peer_finished", "node_peer_acknowledged", "node_transport",
  "task_created", "task_runner_started", "task_spawned", "task_first_output", "task_finished", "task_notification",
  "mailbox_registered", "mailbox_delivered", "mailbox_acknowledged", "mailbox_error", "learning_error",
]);
const id = /^[a-zA-Z0-9_-]{1,110}$/;
const patterns: Record<string, RegExp> = {
  traceId:id, nodeRequestId:id, nodeId:id, bootId:id, revision:/^[a-f0-9]{40}$/,
  stage:/^(body|auth|mcp_dispatch|routing|tool_handler|learning|mailbox|result_packaging|task_launch|task_initial_wait|peer_execute|peer_ack)$/,
  rpcMethod:/^(initialize|notifications\/initialized|notifications\/cancelled|tools\/call|tools\/list|resources\/list|resources\/read|resources\/templates\/list|prompts\/list|prompts\/get|ping|unknown|batch)$/,
  errorCategory:/^(not_found|permission|timeout|invalid_input|indeterminate|transport|internal|tool_error|command_exit|cancelled|auth|protocol)$/,
  errorCode:/^(ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ABORT_ERR|EPIPE|ERR_STREAM_PREMATURE_CLOSE)$/,
  signal:/^SIG(?:TERM|KILL|INT|ABRT|SEGV|HUP|PIPE)$/,
};
export function normalizeEvent(raw: unknown): MonitorEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== "string" || typeof r.ts !== "string" || !Number.isFinite(Date.parse(r.ts))) return null;
  let safe: DiagnosticEntry;
  try { safe = sanitizeDiagnostic(additional.has(r.event) ? "mcp_received" : r.event as DiagnosticEntry["event"], r); }
  catch { return null; }
  const result: MonitorEvent = { ...safe, event:r.event, ts:new Date(r.ts).toISOString() };
  for (const [key,pattern] of Object.entries(patterns)) if (typeof r[key] === "string" && pattern.test(r[key] as string)) (result as unknown as Record<string,unknown>)[key]=r[key];
  for (const key of ["pid","inputBytes","outputBytes","queuedMs"] as const) if (typeof r[key] === "number" && Number.isSafeInteger(r[key]) && r[key] >= 0) result[key]=r[key];
  if(typeof r.exitCode === "number" && Number.isInteger(r.exitCode) && r.exitCode >= -1 && r.exitCode <= 65535)result.exitCode=r.exitCode;
  if(r.event.startsWith("node_") && typeof r.outcome === "string" && /^(ok|error|indeterminate_after_dispatch|not_dispatched|completed_after_host_timeout)$/.test(r.outcome))result.outcome=r.outcome;
  return result;
}
