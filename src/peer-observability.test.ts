import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readPeerSnapshot } from "./peer-observability.js";

test("read-only peer metadata distinguishes fresh, expired and unavailable snapshots", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "synrex-peer-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(readPeerSnapshot(root).coverage, "unavailable");
  const dir = path.join(root, "observability", "peers");
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  await writeFile(path.join(dir, "gateway.status.json"), JSON.stringify({ updatedAt: stamp }));
  await writeFile(path.join(dir, "gateway.diagnostics.jsonl"), JSON.stringify({
    ts: stamp, event: "mcp_finished", requestId: "remote-request", status: 200,
    authorization: "secret", nodeId: "spoofed", traceId: "legacy-trace",
  }) + "\n");
  const fresh = readPeerSnapshot(root, now);
  assert.equal(fresh.coverage, "current");
  assert.equal(fresh.events[0]?.nodeId, "gateway");
  assert.equal(fresh.events[0]?.requestId, "remote-request");
  assert.equal(fresh.events[0]?.traceId, "legacy-trace");
  assert.ok(!JSON.stringify(fresh).includes("secret"));
  assert.equal(readPeerSnapshot(root, now + 200_000).coverage, "stale");
});
