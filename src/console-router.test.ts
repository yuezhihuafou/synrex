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
import { openDatabase } from "./db/client.js";
import { UsageTrafficRecorder } from "./usage-ledger.js";

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

test("explicit title binding requires authenticated, same-origin request and known ID", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-console-title-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  new DiagnosticTrace(dir).record("mcp_finished",{requestId:"req-0001",status:200});
  const app=express(),ownerToken="owner-test-secret";
  registerSynrexConsole(app,{stateDir:dir,publicBaseUrl:"https://console.example.test",
    oauth:{ownerToken}} as ServerConfig);
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/console/api`;
  const cookie="rev_console="+createConsoleSession(ownerToken);
  const body=JSON.stringify({requestId:"req-0001",conversationTitle:"评估全链路日志"});
  const send=(id:string,headers:Record<string,string>,json=body)=>fetch(base+id,{
    method:"POST",headers:{"content-type":"application/json",...headers},body:json,
  });
  assert.equal((await send("/conversation-label",{"origin":"https://console.example.test"})).status,401);
  assert.equal((await send("/conversation-label",{cookie,origin:"https://evil.example.test"})).status,403);
  assert.equal((await send("/conversation-label",{cookie,origin:"https://console.example.test"},
    JSON.stringify({requestId:"not-present",conversationTitle:"Title"}))).status,404);
  assert.equal((await send("/conversation-label",{cookie,origin:"https://console.example.test"})).status,200);
  const trace=await fetch(base+"/trace?requestId=req-0001",{headers:{cookie}});
  const detail=await trace.json() as {conversationTitle:string;titleSource:string};
  assert.equal(detail.conversationTitle,"评估全链路日志");
  assert.equal(detail.titleSource,"owner");
});

test("owner-only HTTP snapshot exposes usage while unauthenticated clients are rejected", async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-console-http-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const db = openDatabase(stateDir); db.close();
  const recorder = new UsageTrafficRecorder(stateDir);
  recorder.record({ event: "mcp_received", ts: new Date().toISOString(), requestId: "r1", inputBytes: 250 });
  assert.ok(recorder.flush()); recorder.close();
  const app=express();
  const ownerToken="test-owner-secret";
  const config={stateDir,publicBaseUrl:"http://127.0.0.1:12345",oauth:{ownerToken}} as ServerConfig;
  registerSynrexConsole(app,config);
  const server=app.listen(0,"127.0.0.1");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once("listening",()=>resolve()));
  const port=(server.address() as {port:number}).port;
  const endpoint=`http://127.0.0.1:${port}/console/api/snapshot`;
  assert.equal((await fetch(endpoint)).status,401);
  const response=await fetch(endpoint,{headers:{cookie:`rev_console=${createConsoleSession(ownerToken)}`}});
  assert.equal(response.status,200);
  const snapshot=await response.json() as {usage:{periods:{"24h":{requests:number;inputBytes:number}}}};
  assert.equal(snapshot.usage.periods["24h"].requests,1);
  assert.equal(snapshot.usage.periods["24h"].inputBytes,250);
});
