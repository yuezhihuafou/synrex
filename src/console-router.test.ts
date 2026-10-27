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

test("local desktop console accepts its exact loopback origin", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-console-local-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const app=express(),ownerToken="owner-test-token";
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const port=(server.address() as {port:number}).port;
  registerSynrexConsole(app,{stateDir:dir,port,publicBaseUrl:"https://console.example.test",
    oauth:{ownerToken}} as ServerConfig);
  const response=await fetch(`http://127.0.0.1:${port}/console/api/login`,{
    method:"POST",headers:{origin:`http://127.0.0.1:${port}`,"content-type":"application/json"},
    body:JSON.stringify({password:ownerToken}),
  });
  assert.equal(response.status,200);
  const cookie=response.headers.get("set-cookie")??"";
  assert.match(cookie,/rev_console=/);
  assert.doesNotMatch(cookie,/; Secure/i);
});

test("Windows bridge obtains the Control action token server-side", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-console-bridge-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const fakeFetch:typeof fetch=async(input,init)=>{
    const url=String(input);calls.push({url,init});
    if(url.endsWith("/api/action-token"))return new Response(JSON.stringify({token:"test-action-value"}),{status:200});
    if(url.endsWith("/api/status"))return new Response(JSON.stringify({platform:"win32"}),{status:200});
    if(url.endsWith("/api/management/service"))return new Response(JSON.stringify({ok:true}),{status:200});
    return new Response(JSON.stringify({error:"not found"}),{status:404});
  };
  const app=express(),ownerToken="owner-test-token";
  registerSynrexConsole(app,{stateDir:dir,port:17677,publicBaseUrl:"https://console.example.test",
    oauth:{ownerToken}} as ServerConfig,{windowsControlBaseUrl:"http://127.0.0.1:17678",fetchImpl:fakeFetch});
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/console/api/windows`;
  const cookie="rev_console="+createConsoleSession(ownerToken);
  assert.equal((await fetch(base+"/status",{headers:{cookie}})).status,200);
  assert.equal(calls.some(call=>call.url.endsWith("/api/action-token")),false);
  const response=await fetch(base+"/service",{method:"POST",headers:{cookie,origin:"https://console.example.test",
    "content-type":"application/json"},body:JSON.stringify({target:"tunnel",action:"restart"})});
  assert.equal(response.status,200);
  const action=calls.find(call=>call.url.endsWith("/api/management/service"));
  const headers=action?.init?.headers as Record<string,string>;
  assert.equal(headers.origin,"http://127.0.0.1:17678");
  assert.equal(headers["x-devspace-console-token"],"test-action-value");
});
