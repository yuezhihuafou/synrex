import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleSession, verifyConsoleSession } from "./console-router.js";
import { registerSynrexConsole } from "./console-router.js";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import type { ServerConfig } from "./config.js";

test("owner console session is signed, expiring and isolated from another secret", () => {
  const now = Date.now();
  const token = createConsoleSession("owner-secret-1", now);
  assert.ok(verifyConsoleSession(token, "owner-secret-1", now));
  assert.equal(verifyConsoleSession(token, "owner-secret-2", now), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", now + 9 * 60 * 60_000), false);
  assert.equal(verifyConsoleSession(token + "changed", "owner-secret-1", now), false);
  assert.equal(verifyConsoleSession("../../", "owner-secret-1", now), false);
  assert.ok(!token.includes("owner-secret"));
});

test("browser trace query stays owner-authenticated, bounded and read-only", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "synrex-console-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(dir);
  diagnostics.record("mcp_received", { requestId: "request-1" });
  diagnostics.record("mcp_finished", { requestId: "request-1", durationMs: 24, status: 200 });
  const app = express();
  const secret = "owner-test-token";
  registerSynrexConsole(app, {
    stateDir: dir, publicBaseUrl: "https://console.example.test",
    oauth: { ownerToken: secret },
  } as ServerConfig);
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise<void>((resolve,reject) =>
    server.close(error=>error?reject(error):resolve())));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/console/api/trace`;
  assert.equal((await fetch(base+"?requestId=request-1")).status, 401);
  const cookie = "rev_console="+createConsoleSession(secret);
  const missing = await fetch(base+"?requestId=../../secret", { headers: {cookie} });
  assert.equal(missing.status, 400);
  const response = await fetch(base+"?requestId=request-1", { headers: {cookie} });
  assert.equal(response.status, 200);
  const payload = await response.json() as {events:Array<{event:string;requestId:string}>; truncated:boolean};
  assert.deepEqual(payload.events.map(x=>x.event), ["mcp_received","mcp_finished"]);
  assert.ok(payload.events.every(x=>x.requestId==="request-1"));
  assert.equal(payload.truncated, false);
});
