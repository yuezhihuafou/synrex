import { randomBytes } from "node:crypto";

/** W3C Trace Context on the wire, separate from legacy Synrex UUID traceId. */
export interface OtelContext {
  otelTraceId: string;
  otelSpanId: string;
  otelParentSpanId?: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const VALID_TRACE = /^(?!0{32}$)[0-9a-f]{32}$/;
const VALID_SPAN = /^(?!0{16}$)[0-9a-f]{16}$/;

export function newSpanId(): string { return randomBytes(8).toString("hex"); }
export function newTraceId(): string { return randomBytes(16).toString("hex"); }

export function parseTraceparent(value: unknown): { traceId: string; parentSpanId: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT.exec(value);
  if (!match || match[1] === "ff" || !VALID_TRACE.test(match[2]!) || !VALID_SPAN.test(match[3]!)) return undefined;
  // Version 00 has exactly 55 characters, without vendor extensions.
  if (match[1] === "00" && value.length !== 55) return undefined;
  return { traceId: match[2]!, parentSpanId: match[3]! };
}

export function newOtelContext(parent?: unknown): OtelContext {
  const validParent = parseTraceparent(parent);
  return {
    otelTraceId: validParent?.traceId ?? newTraceId(),
    otelSpanId: newSpanId(),
    ...(validParent ? { otelParentSpanId: validParent.parentSpanId } : {}),
  };
}

export function childOtelContext(parent: OtelContext): OtelContext {
  return { otelTraceId: parent.otelTraceId, otelSpanId: newSpanId(), otelParentSpanId: parent.otelSpanId };
}

export function validOtelContext(value: Record<string, unknown>): OtelContext | undefined {
  if (!VALID_TRACE.test(String(value.otelTraceId)) || !VALID_SPAN.test(String(value.otelSpanId))) return undefined;
  const parent = value.otelParentSpanId;
  return {
    otelTraceId: String(value.otelTraceId),
    otelSpanId: String(value.otelSpanId),
    ...(typeof parent === "string" && VALID_SPAN.test(parent) ? { otelParentSpanId: parent } : {}),
  };
}
