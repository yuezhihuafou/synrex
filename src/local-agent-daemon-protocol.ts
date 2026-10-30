import type {
  LocalAgentRecord,
  LocalAgentEvent,
  LocalAgentStats,
  LocalAgentStatus,
  LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import type {
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";
import type { AgentContextRequest } from "./local-agent-context-pack.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

export type LocalAgentDaemonMethod =
  | "hello"
  | "agent.start"
  | "agent.continue"
  | "agent.get"
  | "agent.list"
  | "agent.events"
  | "agent.stats"
  | "daemon.status"
  | "daemon.stop"
  | "daemon.logs";

export type LocalAgentDaemonRequest =
  | AgentDaemonRequestBase<"hello", Record<string, never>>
  | AgentDaemonRequestBase<"agent.start", StartLocalAgentInput>
  | AgentDaemonRequestBase<"agent.continue", { id: string; prompt: string; scope: LocalAgentWorkspaceScope; overrides?: RunOverrides }>
  | AgentDaemonRequestBase<"agent.get", {
      id: string; scope: LocalAgentWorkspaceScope;
      includeEvidence?: boolean; evidenceRef?: string;
    }>
  | AgentDaemonRequestBase<"agent.list", LocalAgentWorkspaceScope>
  | AgentDaemonRequestBase<"agent.events", { id: string; scope: LocalAgentWorkspaceScope; afterSeq?: number; limit?: number }>
  | AgentDaemonRequestBase<"agent.stats", LocalAgentWorkspaceScope>
  | AgentDaemonRequestBase<"daemon.status", Record<string, never>>
  | AgentDaemonRequestBase<"daemon.stop", Record<string, never>>
  | AgentDaemonRequestBase<"daemon.logs", { lines?: number }>;

interface AgentDaemonRequestBase<
  M extends LocalAgentDaemonMethod,
  P,
> {
  requestId: string;
  protocolVersion: number;
  authToken: string;
  method: M;
  params: P;
}

export interface LocalAgentDaemonStatus {
  state: "ready" | "stopping";
  protocolVersion: number;
  pid: number;
  endpoint: string;
  startedAt: string;
  activeTurns: number;
  runtimeCount: number;
  clientConnections: number;
}

export interface LocalAgentDaemonErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  provider?: string;
  agentId?: string;
  workspaceId?: string;
  operation?: string;
  target?: string;
}

export type LocalAgentDaemonResponse =
  | {
      requestId: string;
      protocolVersion: number;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      protocolVersion: number;
      ok: false;
      error: LocalAgentDaemonErrorPayload;
    };

export function encodeLocalAgentDaemonRequest(request: LocalAgentDaemonRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeLocalAgentDaemonResponse(response: LocalAgentDaemonResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function decodeLocalAgentDaemonRequest(value: unknown): LocalAgentDaemonRequest {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  const authToken = requiredString(record?.authToken, "authToken");
  const method = requiredString(record?.method, "method") as LocalAgentDaemonMethod;
  const params = record?.params;

  switch (method) {
    case "hello":
    case "daemon.status":
    case "daemon.stop":
      return { requestId, protocolVersion, authToken, method, params: decodeEmptyParams(params) } as LocalAgentDaemonRequest;
    case "agent.start":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeStartInput(params),
      } as LocalAgentDaemonRequest;
    case "agent.continue":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeContinueInput(params),
      } as LocalAgentDaemonRequest;
    case "agent.get":
      return {
        requestId,
        protocolVersion,
        method,
        authToken,
        params: {
          id: requiredString(asRecord(params)?.id, "id"),
          scope: decodeWorkspaceScope(asRecord(params)?.scope),
          ...(asRecord(params)?.includeEvidence === true ? { includeEvidence: true } : {}),
          ...(optionalString(asRecord(params)?.evidenceRef)
            ? { evidenceRef: optionalString(asRecord(params)?.evidenceRef) } : {}),
        },
      } as LocalAgentDaemonRequest;
    case "agent.list":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeListScope(params),
      } as LocalAgentDaemonRequest;
    case "agent.events": {
      const paramsRecord = asRecord(params);
      const afterSeq = paramsRecord?.afterSeq;
      const limit = paramsRecord?.limit;
      if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0)) {
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "afterSeq must be a non-negative integer.");
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 500)) {
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "limit must be between 1 and 500.");
      }
      return {
        requestId, protocolVersion, authToken, method,
        params: {
          id: requiredString(paramsRecord?.id, "id"),
          scope: decodeWorkspaceScope(paramsRecord?.scope),
          afterSeq: afterSeq as number | undefined,
          limit: limit as number | undefined,
        },
      };
    }
    case "agent.stats":
      return { requestId, protocolVersion, authToken, method, params: decodeWorkspaceScope(params) };
    case "daemon.logs":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeLogsParams(params),
      } as LocalAgentDaemonRequest;
    default:
      throw new LocalAgentDaemonProtocolError("UNKNOWN_METHOD", `Unknown daemon method: ${method}`);
  }
}

export function decodeLocalAgentDaemonResponse(value: unknown): LocalAgentDaemonResponse {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  if (record?.ok === true) {
    return { requestId, protocolVersion, ok: true, result: record.result };
  }
  if (record?.ok === false) {
    const error = asRecord(record.error);
    return {
      requestId,
      protocolVersion,
      ok: false,
      error: {
        code: requiredString(error?.code, "error.code"),
        message: requiredString(error?.message, "error.message"),
        retryable: optionalBoolean(error?.retryable),
        provider: optionalString(error?.provider),
        agentId: optionalString(error?.agentId),
        workspaceId: optionalString(error?.workspaceId),
        operation: optionalString(error?.operation),
        target: optionalString(error?.target),
      },
    };
  }
  throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon returned an invalid response.");
}

export function decodeAgentRecord(value: unknown): LocalAgentRecord {
  const record = asRecord(value);
  const status = requiredString(record?.status, "status");
  if (!isLocalAgentStatus(status)) throw new LocalAgentDaemonProtocolError("INVALID_RECORD", "Invalid agent status.");
  return {
    id: requiredString(record?.id, "id"),
    workspaceId: optionalString(record?.workspaceId),
    workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
    profileName: requiredString(record?.profileName, "profileName"),
    provider: requiredString(record?.provider, "provider"),
    model: optionalString(record?.model),
    effort: optionalString(record?.effort),
    providerSessionId: optionalString(record?.providerSessionId),
    status,
    latestResponse: optionalContentString(record?.latestResponse),
    error: optionalContentString(record?.error),
    errorCode: optionalString(record?.errorCode),
    errorRetryable: optionalBoolean(record?.errorRetryable),
    ...(asRecord(record?.evidenceSummary) ? {
      evidenceSummary: record!.evidenceSummary as LocalAgentRecord["evidenceSummary"],
    } : {}),
    ...(asRecord(record?.evidence) ? {
      evidence: record!.evidence as LocalAgentRecord["evidence"],
    } : {}),
    createdAt: requiredString(record?.createdAt, "createdAt"),
    updatedAt: requiredString(record?.updatedAt, "updatedAt"),
  };
}

export function decodeAgentRecordList(value: unknown): LocalAgentRecord[] {
  if (!Array.isArray(value)) throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid agent list.");
  return value.map(decodeAgentRecord);
}

export function decodeAgentEvents(value: unknown): LocalAgentEvent[] {
  if (!Array.isArray(value)) throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Invalid agent event list.");
  return value.map((value) => {
    const event = asRecord(value);
    if (!event) throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Invalid agent event.");
    return {
      ...event,
      seq: requiredInteger(event.seq, "seq"),
      agentId: requiredString(event.agentId, "agentId"),
      at: requiredString(event.at, "at"),
      kind: requiredString(event.kind, "kind"),
    } as LocalAgentEvent;
  });
}

export function decodeAgentStats(value: unknown): LocalAgentStats {
  const result = asRecord(value);
  if (!result || !asRecord(result.byProvider)) {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Invalid agent statistics.");
  }
  for (const key of ["sessions", "running", "completed", "failed", "turns", "successfulTurns", "failedTurns", "durationMs"]) {
    requiredInteger(result[key], key);
  }
  return result as unknown as LocalAgentStats;
}

export function decodeDaemonStatus(value: unknown): LocalAgentDaemonStatus {
  const record = asRecord(value);
  const state = requiredString(record?.state, "state");
  if (state !== "ready" && state !== "stopping") {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid status.");
  }
  return {
    state,
    protocolVersion: requiredInteger(record?.protocolVersion, "protocolVersion"),
    pid: requiredInteger(record?.pid, "pid"),
    endpoint: requiredString(record?.endpoint, "endpoint"),
    startedAt: requiredString(record?.startedAt, "startedAt"),
    activeTurns: requiredInteger(record?.activeTurns, "activeTurns"),
    runtimeCount: requiredInteger(record?.runtimeCount, "runtimeCount"),
    clientConnections: requiredInteger(record?.clientConnections, "clientConnections"),
  };
}

export function decodeDaemonLogs(value: unknown): string {
  if (typeof value !== "string") throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned invalid logs.");
  return value;
}

export class LocalAgentDaemonProtocolError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalAgentDaemonProtocolError";
  }
}

function decodeEmptyParams(value: unknown): Record<string, never> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record || Object.keys(record).length > 0) {
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "This daemon method does not accept parameters.");
  }
  return {};
}

function decodeStartInput(value: unknown): StartLocalAgentInput {
  const record = asRecord(value);
  return {
    target: requiredString(record?.target, "target"),
    prompt: requiredContentString(record?.prompt, "prompt"),
    workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
    workspaceId: optionalString(record?.workspaceId),
    model: optionalString(record?.model),
    effort: optionalString(record?.effort),
    writeMode: decodeWriteMode(record?.writeMode),
    context: decodeContextRequest(record?.context),
  };
}

function decodeContinueInput(value: unknown): { id: string; prompt: string; scope: LocalAgentWorkspaceScope; overrides?: RunOverrides } {
  const record = asRecord(value);
  const overrides = asRecord(record?.overrides);
  return {
    id: requiredString(record?.id, "id"),
    prompt: requiredContentString(record?.prompt, "prompt"),
    scope: decodeWorkspaceScope(record?.scope),
    ...(overrides ? { overrides: {
      model: optionalString(overrides.model),
      effort: optionalString(overrides.effort),
      writeMode: decodeWriteMode(overrides.writeMode),
      context: decodeContextRequest(overrides.context),
    } } : {}),
  };
}

function decodeContextRequest(value: unknown): AgentContextRequest | undefined {
  if (value === undefined) return undefined;
  const data = asRecord(value);
  if (!data) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Context must be an object.");
  if (Object.keys(data).some((key) => !["workflowId", "files", "memoryProject", "contextRef", "maxBytes"].includes(key))) {
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Unknown context option.");
  }
  const out: AgentContextRequest = {};
  for (const key of ["workflowId", "memoryProject", "contextRef"] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "string" || data[key].length > 512) {
        throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid context " + key + ".");
      }
      out[key] = data[key] as string;
    }
  }
  if (data.files !== undefined) {
    if (!Array.isArray(data.files) || data.files.length > 16 ||
        data.files.some((file) => typeof file !== "string" || file.length > 300)) {
      throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid context file hints.");
    }
    out.files = data.files as string[];
  }
  if (data.maxBytes !== undefined) {
    if (!Number.isInteger(data.maxBytes) || (data.maxBytes as number) < 2_000 || (data.maxBytes as number) > 20_000) {
      throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid context byte budget.");
    }
    out.maxBytes = data.maxBytes as number;
  }
  return out;
}

function decodeWorkspaceScope(value: unknown): LocalAgentWorkspaceScope {
  const record = asRecord(value);
  if (!record) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Workspace scope is required.");
  return {
    workspaceId: optionalString(record.workspaceId),
    workspaceRoot: requiredString(record.workspaceRoot, "scope.workspaceRoot"),
  };
}

function decodeListScope(value: unknown): LocalAgentWorkspaceScope {
  return decodeWorkspaceScope(value);
}

function decodeLogsParams(value: unknown): { lines?: number } {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log options must be an object.");
  const lines = record.lines;
  if (lines === undefined) return {};
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 10_000) {
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log lines must be an integer between 1 and 10000.");
  }
  return { lines };
}

function decodeWriteMode(value: unknown): LocalAgentWriteMode | undefined {
  if (value === undefined) return undefined;
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid write mode.");
}

function isLocalAgentStatus(value: string): value is LocalAgentStatus {
  return value === "starting" || value === "running" || value === "idle" || value === "error" || value === "stopped";
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
  return result;
}

function requiredContentString(value: unknown, field: string): string {
  const result = optionalContentString(value);
  if (result === undefined) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
  return result;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LocalAgentDaemonProtocolError("INVALID_PROTOCOL", `Invalid ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalContentString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function supportedDaemonProtocolVersion(): number {
  return LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
}
