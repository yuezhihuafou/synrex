#!/usr/bin/env node
// Bounded, read-only metadata mirror for the owner Web Console. Each peer
// retains its own authoritative OTLP history. A stale mirror is never live.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.env.SYNREX_STATE_DIR;
if (!root || !path.isAbsolute(root)) process.exit(2);
const dest = path.join(root, "observability", "peers");
mkdirSync(dest, { recursive: true, mode: 0o700 });

// The host and source directories are fixed operator-owned deployment inputs,
// never HTTP parameters. Do not stream arbitrary command output through API.
function copy(kind, remote) {
  const output = execFileSync("ssh", [
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=3", "gateway", "tail", "-n", "600", remote,
  ], { encoding: "utf8", timeout: 7000, maxBuffer: 768 * 1024 });
  const lines = output.split("\n").flatMap(line => {
    if (line.length < 2 || line.length > 4096) return [];
    try {
      const record = JSON.parse(line);
      if (typeof record.ts !== "string" || !Number.isFinite(Date.parse(record.ts))
        || typeof record.event !== "string" || !/^[a-z][a-z0-9_]{2,60}$/.test(record.event)) return [];
      const allow = ["ts","event","traceId","requestId","callId","nodeRequestId","otelTraceId","otelSpanId","otelParentSpanId",
        "nodeId","bootId","revision","pid","stage","tool","status","durationMs","elapsedMs","queuedMs","inputBytes","outputBytes",
        "errorCategory","outcome","taskId","runId","workspaceId","phase",
        "tcpConnections","tcpRttP50Ms","tcpRttP95Ms","tcpRetransSockets","tcpRetransSegmentsTotal",
        "collectorRefusedLogRecords","collectorRefusedMetricPoints","collectorExporterFailed"];
      const result = Object.fromEntries(allow.filter(key => record[key] !== undefined).map(key => [key,record[key]]));
      result.nodeId = "gateway";
      return [JSON.stringify(result)];
    } catch { return []; }
  });
  const file = path.join(dest, `gateway.${kind}.jsonl`);
  writeFileSync(file + ".tmp", lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return lines.length;
}
try {
  const diagnostics = copy("diagnostics", "/home/swy/.local/share/devspace/diagnostics/recent.jsonl");
  const network = copy("network", "/home/swy/.local/share/devspace/observability/network.jsonl");
  writeFileSync(path.join(dest, "gateway.status.json.tmp"),
    JSON.stringify({ updatedAt: new Date().toISOString(), nodeId: "gateway", diagnostics, network }) + "\n",
    { mode: 0o600 });
  renameSync(path.join(dest, "gateway.status.json.tmp"), path.join(dest, "gateway.status.json"));
} catch {
  // A temporarily unavailable peer must not erase previously captured data
  // or break the owner, Console or collector. Exit nonzero for timer diagnostics.
  process.exitCode = 1;
}
