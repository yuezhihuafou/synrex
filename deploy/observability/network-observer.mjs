#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import path from "node:path";

// Bounded, unprivileged metadata-only observer. Never log socket addresses,
// HTTP contents, command lines, URL, arbitrary journal text or tokens.
const root = process.env.SYNREX_STATE_DIR;
const nodeId = process.env.SYNREX_NODE_ID;
if (!root || !path.isAbsolute(root) || !/^[a-zA-Z0-9_-]{1,64}$/.test(nodeId ?? "")) process.exit(2);
const directory = path.join(root, "observability");
const logfile = path.join(directory, "network.jsonl");
const cursorFile = path.join(directory, "journal.cursor");
const bootId = randomUUID();
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);

function run(program, args) {
  try { return execFileSync(program, args, {
    encoding: "utf8", timeout: 2200, maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "ignore"],
  }); } catch { return ""; }
}
function record(event, fields = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, nodeId,
      bootId, pid: process.pid, ...fields }) + "\n";
    if (existsSync(logfile) && statSync(logfile).size + Buffer.byteLength(line) > 4 * 1024 * 1024) {
      renameSync(logfile, logfile + ".1");
    }
    appendFileSync(logfile, line, { mode: 0o600 });
  } catch { /* Never affect the monitored services. */ }
}
function percentile(values, p) {
  if (!values.length) return undefined;
  return Math.round(values[Math.floor((values.length - 1) * p)]);
}
function retransSegments() {
  try {
    const rows = readFileSync("/proc/net/snmp", "utf8").split("\n");
    for (let i = 0; i < rows.length - 1; i++) {
      if (!rows[i].startsWith("Tcp: ") || !rows[i + 1].startsWith("Tcp: ")) continue;
      const keys = rows[i].split(/\s+/).slice(1);
      const vals = rows[i + 1].split(/\s+/).slice(1);
      const index = keys.indexOf("RetransSegs");
      if (index >= 0) return Number(vals[index]);
    }
  } catch { /* No /proc access. */ }
  return undefined;
}
function sampleConnections() {
  const text = run("ss", ["-H", "-tin", "state", "established"]);
  const rtts = [...text.matchAll(/\brtt:(\d+(?:\.\d+)?)\//g)]
    .map(x => Number(x[1])).filter(Number.isFinite).sort((a, b) => a - b);
  const retrans = [...text.matchAll(/\bretrans:(\d+)\//g)]
    .filter(x => Number(x[1]) > 0).length;
  const counter = retransSegments();
  record("network_sampled", {
    tcpConnections: rtts.length, tcpRetransSockets: retrans,
    ...(rtts.length ? { tcpRttP50Ms: percentile(rtts, .5), tcpRttP95Ms: percentile(rtts, .95) } : {}),
    ...(Number.isSafeInteger(counter) && counter >= 0 ? { tcpRetransSegmentsTotal: counter } : {}),
  });
}
function sampleCollector() {
  const request = get("http://127.0.0.1:8888/metrics", { timeout: 1500 }, response => {
    let content = "";
    response.on("data", chunk => {
      if (content.length < 2_000_000) content += String(chunk).slice(0, 2_000_000 - content.length);
    });
    response.on("end", () => {
      if (response.statusCode !== 200) return;
      const metrics = [
        ["collectorRefusedLogRecords", "otelcol_receiver_refused_log_records"],
        ["collectorRefusedMetricPoints", "otelcol_receiver_refused_metric_points"],
        ["collectorExporterFailed", "otelcol_exporter_send_failed_log_records"],
        ["collectorExporterFailed", "otelcol_exporter_send_failed_metric_points"],
      ];
      const totals = {};
      for (const [name, prefix] of metrics) {
        const values = content.split("\n").filter(line => line.startsWith(prefix + "{")
          || line.startsWith(prefix + " ")).map(line => Number(line.split(/\s+/).at(-1)))
          .filter(Number.isFinite);
        if (values.length) totals[name] = (totals[name] ?? 0) + values.reduce((a,b)=>a+b, 0);
      }
      record("collector_sampled", totals);
    });
  });
  request.on("error", () => record("collector_sampled", {}));
  request.on("timeout", () => request.destroy());
}
function classify(message) {
  if (message.includes("Registered tunnel connection")) return "tunnel_registered";
  if (message.includes("Retrying connection")) return "tunnel_retry";
  if (message.includes("Connection terminated") || message.includes("Serve tunnel error")) return "tunnel_disconnected";
  if (message.includes("Unable to reach the origin service")) return "origin_unavailable";
  if (message.startsWith("Started devspace.service")) return "service_started";
  if (message.startsWith("Stopped devspace.service")) return "service_stopped";
  return undefined;
}
function sampleJournal() {
  const previous = existsSync(cursorFile) ? readFileSync(cursorFile, "utf8").trim() : "";
  const args = ["--user", "-u", "devspace.service", "-u", "cloudflared-devspace.service",
    "--no-pager", "-o", "json", ...(previous ? ["--after-cursor", previous] : ["--since", "60 seconds ago"])];
  const text = run("journalctl", args);
  let cursor = previous;
  for (const line of text.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (typeof row.__CURSOR === "string" && row.__CURSOR.length < 2048) cursor = row.__CURSOR;
      const kind = typeof row.MESSAGE === "string" ? classify(row.MESSAGE) : undefined;
      if (kind) record(kind);
    } catch { /* Ignore unmatched/partial messages. */ }
  }
  if (cursor !== previous) {
    try {
      writeFileSync(cursorFile + ".tmp", cursor, { mode: 0o600 });
      renameSync(cursorFile + ".tmp", cursorFile);
    } catch { /* No privileged or destructive fallback. */ }
  }
}
function sample() { sampleConnections(); sampleJournal(); sampleCollector(); }
sample();
const timer = setInterval(sample, 10_000);
// Keep a bounded observer alive until terminated by its own systemd service.
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
