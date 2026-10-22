import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

export type OAuthHttpPhase = "discovery" | "registration" | "authorize" | "token" | "revoke";

export interface RequestLogContext {
  requestId: string;
  path: string;
  oauthPhase?: OAuthHttpPhase;
  traceId?: string;
  otelTraceId?: string;
  otelSpanId?: string;
  otelParentSpanId?: string;
  startedAt?: number;
  callId?: string;
  nodeRequestId?: string;
  emitDiagnostic?: (event: import("./diagnostic-trace.js").DiagnosticEvent, fields: Record<string, unknown>) => void;
}

const requestLogContext = new AsyncLocalStorage<RequestLogContext>();

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  // Express nested routers rewrite req.url/req.path to "/". originalUrl is
  // stable and keeps OAuth endpoint logs attributable to the real route.
  const rawUrl = req.originalUrl || req.url;
  return rawUrl.split("?", 1)[0] || "/";
}

export function oauthPhaseForPath(path: string): OAuthHttpPhase | undefined {
  if (path === "/.well-known/oauth-authorization-server"
    || path.startsWith("/.well-known/oauth-protected-resource")) return "discovery";
  if (path === "/register") return "registration";
  if (path === "/authorize") return "authorize";
  if (path === "/token") return "token";
  if (path === "/revoke") return "revoke";
  return undefined;
}

export function runWithRequestLogContext<T>(context: RequestLogContext, callback: () => T): T {
  return requestLogContext.run(context, callback);
}

export function currentRequestLogContext(): RequestLogContext | undefined {
  return requestLogContext.getStore();
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
