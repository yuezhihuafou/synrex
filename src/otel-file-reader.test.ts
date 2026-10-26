import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOtelFileTail } from "./otel-file-reader.js";

test("local OTLP archive tail extracts allowlisted log metadata and host metrics", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-otel-tail-"));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  const dir = path.join(stateDir, "observability", "data");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  await writeFile(path.join(dir, "logs.otlp.json"), JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{
      body: { stringValue: "should-not-export-secret" },
      attributes: [
        { key: "event", value: { stringValue: "mcp_finished" } },
        { key: "ts", value: { stringValue: ts } },
        { key: "requestId", value: { stringValue: "request-1" } },
        { key: "status", value: { intValue: "200" } },
        { key: "prompt", value: { stringValue: "private" } },
      ],
    }] }] }],
  }) + "\n");
  await writeFile(path.join(dir, "metrics.otlp.json"), JSON.stringify({
    resourceMetrics: [{
      resource: { attributes: [{ key: "synrex.node.id", value: { stringValue: "swy1" } }] },
      scopeMetrics: [{ metrics: [{ name: "system.memory.usage",
        gauge: { dataPoints: [{ asInt: "1234", timeUnixNano: String(BigInt(Date.now()) * 1000000n) }] },
      }] }],
    }],
  }) + "\n");
  const archive = readOtelFileTail(stateDir);
  assert.equal(archive.coverage, "bounded_tail");
  assert.equal(archive.logs[0]?.event, "mcp_finished");
  assert.equal(archive.logs[0]?.requestId, "request-1");
  assert.equal(archive.logs[0]?.status, 200);
  assert.ok(!JSON.stringify(archive).includes("private"));
  assert.ok(!JSON.stringify(archive).includes("should-not-export-secret"));
  assert.equal(archive.metrics[0]?.nodeId, "swy1");
  assert.equal(archive.metrics[0]?.value, 1234);
});
