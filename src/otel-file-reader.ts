import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sanitizeDiagnostic, type DiagnosticEntry } from "./diagnostic-trace.js";

/** Read bounded tails of the Collector's local JSONL OTLP files. Not a query index. */
const TAIL_BYTES = 384 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
type ObjectValue = Record<string, unknown>;

function obj(v: unknown): ObjectValue {
  return v && typeof v === "object" && !Array.isArray(v) ? v as ObjectValue : {};
}
function list(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function anyValue(value: unknown): string | number | boolean | undefined {
  const o = obj(value);
  if (typeof o.stringValue === "string") return o.stringValue;
  if (typeof o.boolValue === "boolean") return o.boolValue;
  const v = o.intValue ?? o.doubleValue;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function attrs(value: unknown): ObjectValue {
  return Object.fromEntries(list(value).flatMap(a => {
    const row = obj(a);
    return typeof row.key === "string" && row.key.length < 90
      ? [[row.key, anyValue(row.value)]] : [];
  }));
}
function isoFromNano(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{16,20}$/.test(value)) return undefined;
  const ms = Number(BigInt(value) / 1_000_000n);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function tailLines(file: string): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const bytes = Math.min(size, TAIL_BYTES);
    const start = size - bytes;
    const buffer = Buffer.alloc(bytes);
    fd = openSync(file, "r");
    const n = readSync(fd, buffer, 0, bytes, start);
    const result = buffer.toString("utf8", 0, n);
    const lines = result.split("\n");
    if (start > 0) lines.shift(); // discard partial first record
    if (lines.at(-1) !== "") lines.pop(); // discard incomplete final record
    return lines.filter(line => line.length < MAX_RECORD_BYTES);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function files(stateDir: string, kind: "logs" | "metrics"): string[] {
  const dir = path.join(stateDir, "observability", "data");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(name =>
      name === `${kind}.otlp.json` || new RegExp(`^${kind}\\.otlp[-.].*\\.json$`).test(name))
      .map(name => path.join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 2);
  } catch { return []; }
}

export interface HostMetricSample {
  ts: string;
  name: string;
  value: number;
  nodeId?: string;
  processPid?: number;
  processName?: string;
}

export interface OTelFileTail {
  available: boolean;
  coverage: "bounded_tail" | "not_collected";
  logs: DiagnosticEntry[];
  metrics: HostMetricSample[];
}
let cache: { key: string; until: number; value: OTelFileTail } | undefined;

export function readOtelFileTail(stateDir: string): OTelFileTail {
  const now = Date.now();
  if (cache?.key === stateDir && cache.until > now) return cache.value;
  const logFiles = files(stateDir, "logs");
  const metricFiles = files(stateDir, "metrics");
  const logs: DiagnosticEntry[] = [];
  const metrics: HostMetricSample[] = [];
  for (const file of logFiles) {
    for (const line of tailLines(file)) {
      let document: ObjectValue;
      try { document = obj(JSON.parse(line)); } catch { continue; }
      for (const resource of list(document.resourceLogs)) {
        const resourceAttributes = attrs(obj(obj(resource).resource).attributes);
        for (const scope of list(obj(resource).scopeLogs)) {
          for (const raw of list(obj(scope).logRecords)) {
            const row = obj(raw);
            const attributes = attrs(row.attributes);
            const body = anyValue(row.body);
            const bodyFields = typeof body === "string" && body.startsWith("{") && body.length < 4_000
              ? (() => { try { return obj(JSON.parse(body)); } catch { return {}; } })() : {};
            const data: ObjectValue = { ...bodyFields, ...attributes,
              nodeId: attributes.nodeId ?? resourceAttributes["synrex.node.id"] };
            if (typeof data.event !== "string") continue;
            try {
              const item = sanitizeDiagnostic(data.event as DiagnosticEntry["event"], data);
              const ts = typeof data.ts === "string" ? data.ts : isoFromNano(row.timeUnixNano);
              if (ts && Number.isFinite(Date.parse(ts))) item.ts = ts;
              logs.push(item);
            } catch { /* Only declared diagnostic events are accepted. */ }
          }
        }
      }
    }
  }
  for (const file of metricFiles) {
    for (const line of tailLines(file)) {
      let document: ObjectValue;
      try { document = obj(JSON.parse(line)); } catch { continue; }
      for (const resource of list(document.resourceMetrics)) {
        const resourceAttrs = attrs(obj(resource).resource && obj(obj(resource).resource).attributes);
        for (const scope of list(obj(resource).scopeMetrics)) {
          for (const rawMetric of list(obj(scope).metrics)) {
            const metric = obj(rawMetric);
            if (typeof metric.name !== "string" || !/^(system|process)\.[a-z0-9_.]+$/.test(metric.name)) continue;
            const points = list(obj(metric.gauge).dataPoints).concat(list(obj(metric.sum).dataPoints));
            for (const rawPoint of points) {
              const point = obj(rawPoint), at = attrs(point.attributes);
              const number = Number(point.asDouble ?? point.asInt);
              const ts = isoFromNano(point.timeUnixNano);
              if (!Number.isFinite(number) || !ts) continue;
              metrics.push({
                ts, name: metric.name, value: number,
                ...(typeof resourceAttrs["synrex.node.id"] === "string" ? { nodeId: resourceAttrs["synrex.node.id"] } : {}),
                ...(typeof (resourceAttrs["process.pid"] ?? at["process.pid"]) === "number"
                  ? { processPid: Number(resourceAttrs["process.pid"] ?? at["process.pid"]) } : {}),
                ...(typeof (resourceAttrs["process.executable.name"] ?? at["process.executable.name"]) === "string"
                  ? { processName: String(resourceAttrs["process.executable.name"] ?? at["process.executable.name"]) } : {}),
              });
            }
          }
        }
      }
    }
  }
  const value: OTelFileTail = {
    available: logFiles.length > 0 || metricFiles.length > 0,
    coverage: logFiles.length > 0 || metricFiles.length > 0 ? "bounded_tail" : "not_collected",
    logs: logs.slice(-500),
    metrics: metrics.slice(-600),
  };
  cache = { key: stateDir, until: now + 10_000, value };
  return value;
}
