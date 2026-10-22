import { createHash, randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { ServerConfig } from "./config.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { currentRequestLogContext, logEvent, oauthPhaseForPath, requestPath, runWithRequestLogContext } from "./logger.js";
import { traceEvent } from "./trace-stages.js";
import { newOtelContext } from "./otel-context.js";

/** Mount BEFORE the SDK JSON parser and host checks, so body upload/parse and
 * rejected requests are included. HTTP finish means local flush, not host receipt. */
export function requestTraceMiddleware(config: ServerConfig, diagnostics: DiagnosticTrace,
  requestFields: (req: Request, config: ServerConfig) => Record<string, unknown>): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const otel = newOtelContext(req.header("traceparent"));
    const started = performance.now();
    const path = requestPath(req);
    const oauthPhase = oauthPhaseForPath(path);
    const isMcp = path === "/mcp";
    let stage = "body";
    const context = { requestId, traceId: requestId, ...otel, path, oauthPhase, startedAt: started,
      emitDiagnostic: (event: import("./diagnostic-trace.js").DiagnosticEvent, fields: Record<string, unknown>) => {
        if (typeof fields.stage === "string") stage = fields.stage;
        diagnostics.record(event, fields);
      },
    };
    res.locals.requestId = requestId;
    res.setHeader("x-synrex-request-id", requestId);
    const base = { requestId, traceId: requestId, ...otel, method: req.method };
    const elapsed = () => Math.round(performance.now() - started);
    let responseBodyBytes = 0;
    const countChunk = (chunk: unknown, encoding?: unknown) => {
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) responseBodyBytes += chunk.byteLength;
      else if (typeof chunk === "string") responseBodyBytes += Buffer.byteLength(chunk,
        typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
    };
    const originalWrite = res.write;
    res.write = function(this: typeof res, ...args: any[]) {
      countChunk(args[0], args[1]);
      return (originalWrite as (...args: any[]) => boolean).apply(this, args);
    } as typeof res.write;
    const originalEnd = res.end;
    res.end = function(this: typeof res, ...args: any[]) {
      countChunk(args[0], args[1]);
      return (originalEnd as (...args: any[]) => typeof res).apply(this, args);
    } as typeof res.end;
    if (isMcp) diagnostics.record("mcp_received", {
      ...base, inputBytes: Number(req.header("content-length")), edgeRay: req.header("cf-ray"),
    });
    const mode = () => {
      const type = String(res.getHeader("content-type") ?? "").toLowerCase();
      return type.includes("text/event-stream") ? "sse" : type.includes("json") ? "json" : "unknown";
    };
    const originalWriteHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: Parameters<typeof originalWriteHead>) {
      if (isMcp) diagnostics.record("mcp_headers_sent", { ...base, elapsedMs: elapsed(), status: args[0] });
      return originalWriteHead.apply(this, args);
    } as typeof res.writeHead;
    const timer = isMcp ? setInterval(() => diagnostics.record("request_stalled", { ...base, stage, elapsedMs: elapsed() }), 20_000) : undefined;
    timer?.unref();
    res.once("close", () => {
      if (timer) clearInterval(timer);
      if (!isMcp || res.writableFinished) return;
      const event = mode() === "sse" ? "mcp_stream_closed" : "mcp_closed_early";
      diagnostics.record(event, { ...base, stage, responseMode: mode(), elapsedMs: elapsed(), status: res.statusCode });
      logEvent(config.logging, event === "mcp_stream_closed" ? "info" : "warn", event, { ...base, stage, elapsedMs: elapsed() });
    });
    res.once("finish", () => {
      if (timer) clearInterval(timer);
      if (isMcp) diagnostics.record("mcp_finished", {
        ...base, stage, responseMode: mode(), durationMs: elapsed(), status: res.statusCode,
        outputBytes: responseBodyBytes,
      });
      if (!config.logging.requests || (!config.logging.assets && path.startsWith("/mcp-app-assets"))) return;
      logEvent(config.logging, "info", "http_request", { ...base, path, status: res.statusCode, durationMs: elapsed(), ...requestFields(req, config) });
      if (oauthPhase) logEvent(config.logging, "info", "oauth_http", {
        requestId, phase: oauthPhase, outcome: res.statusCode < 400 ? "success" : "failure", status: res.statusCode, path,
        grantType: oauthPhase === "token" && typeof req.body?.grant_type === "string" ? req.body.grant_type : undefined,
      });
    });
    runWithRequestLogContext(context, next);
  };
}

export const bodyReadyTrace: RequestHandler = (req, _res, next) => {
  if (requestPath(req) === "/mcp") {
    const body = req.body;
    const method = Array.isArray(body) ? "batch" : typeof body?.method === "string" ? body.method : "unknown";
    // Hash arbitrary JSON-RPC IDs; never persist prompts or arbitrary client labels.
    const id = typeof body?.id === "string" || typeof body?.id === "number" ? createHash("sha256").update(String(body.id)).digest("hex").slice(0, 24) : undefined;
    traceEvent("mcp_body_ready", { stage: "body", rpcMethod: method, rpcIdHash: id,
      durationMs: Math.round(performance.now() - (currentRequestLogContext()?.startedAt ?? performance.now())),
      tool: body?.method === "tools/call" && typeof body?.params?.name === "string" ? body.params.name : undefined,
    });
  }
  next();
};
