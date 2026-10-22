import { request } from "node:http";
import type { OtelContext } from "./otel-context.js";

// Minimal OTLP/HTTP JSON exporter. It owns no credentials, has no dependency on
// the collector, and cannot delay an MCP response. Never export prompts/results.
const endpoint = "http://127.0.0.1:14318/v1/traces";
let pending = 0;
let dropped = 0;
const queue: NativeSpan[] = [];
let scheduled: NodeJS.Timeout | undefined;

export type NativeSpan = {
  name: string; context: OtelContext; startMs: number; endMs: number;
  status?: "ok" | "error"; fields?: Record<string, string | number | undefined>;
};

const ns = (ms: number): string => String(BigInt(Math.floor(ms * 1_000_000)));
const value = (v: string | number) => typeof v === "string"
  ? { stringValue: v.slice(0, 120) } : { doubleValue: v };

export function spanPayload(span: NativeSpan): object {
  const attrs = Object.entries(span.fields ?? {})
    .filter((x): x is [string, string | number] => x[1] !== undefined)
    .filter(([key]) => /^[a-zA-Z0-9_.-]{1,60}$/.test(key))
    .slice(0, 12)
    .map(([key, v]) => ({ key, value: value(v) }));
  return { resourceSpans: [{ resource: { attributes: [
    { key: "service.name", value: { stringValue: "synrex" } },
  ] }, scopeSpans: [{ scope: { name: "synrex.native-trace", version: "1" }, spans: [{
    traceId: span.context.otelTraceId,
    spanId: span.context.otelSpanId,
    ...(span.context.otelParentSpanId ? { parentSpanId: span.context.otelParentSpanId } : {}),
    name: span.name.slice(0, 80),
    startTimeUnixNano: ns(span.startMs),
    endTimeUnixNano: ns(Math.max(span.startMs, span.endMs)),
    attributes: attrs,
    status: { code: span.status === "error" ? 2 : 1 },
  }] }] }] };
}

function flush(): void {
  scheduled = undefined;
  if(pending || !queue.length)return;
  const batch = queue.splice(0,128);
  let bytes: Buffer;
  try {
    const first=spanPayload(batch[0]!) as {resourceSpans:Array<{scopeSpans:Array<{spans:unknown[]}>}>};
    const entries=first.resourceSpans[0]!.scopeSpans[0]!.spans;
    for(const item of batch.slice(1)){
      const next=spanPayload(item) as typeof first;
      entries.push(next.resourceSpans[0]!.scopeSpans[0]!.spans[0]);
    }
    bytes=Buffer.from(JSON.stringify(first));
  } catch { dropped+=batch.length; return; }
  pending++;
  try {
    const req = request(endpoint, {
      method: "POST", headers: { "content-type": "application/json",
        "content-length": String(bytes.length) },
      timeout: 1000,
    }, res => { res.resume(); res.on("end", () => { if ((res.statusCode ?? 500) >= 400) dropped+=batch.length; }); });
    let ended = false;
    const finish = () => { if (!ended) { ended = true; pending--; if(queue.length)schedule(); } };
    req.once("close", finish);
    req.once("error", () => { dropped+=batch.length; finish(); });
    req.once("timeout", () => req.destroy());
    req.end(bytes);
  } catch { pending--; dropped+=batch.length; }
}

function schedule():void {
  if(scheduled || pending)return;
  scheduled=setTimeout(flush,50);
  scheduled.unref();
}
export function emitNativeSpan(span: NativeSpan): void {
  // Bounded batcher means an unavailable Collector never blocks live MCP.
  if(queue.length>=4096){dropped++;return;}
  queue.push(span);
  schedule();
}

export function nativeSpanHealth(): { pending: number; dropped: number } {
  return { pending: pending+queue.length, dropped };
}
