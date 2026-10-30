import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consoleAssetBase,
  consoleCookieName,
  consoleSessionAudience,
  createConsoleSession,
  verifyConsoleSession,
} from "./console-router.js";
import { registerSynrexConsole } from "./console-router.js";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import type { ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { UsageTrafficRecorder } from "./usage-ledger.js";
import { readConsoleSnapshot } from "./console-snapshot.js";
import { CodingWorkflowStore } from "./coding-workflows.js";

test("owner console session is signed, expiring and isolated from another secret", () => {
  const now = Date.now();
  const group = consoleSessionAudience("https://dev.sanqi.org/group");
  const personal = consoleSessionAudience("https://dev.sanqi.org/personal");
  const token = createConsoleSession("owner-secret-1", now, group);
  assert.ok(verifyConsoleSession(token, "owner-secret-1", now, group));
  assert.equal(verifyConsoleSession(token, "owner-secret-2", now, group), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", now, personal), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", now + 9 * 60 * 60_000, group), false);
  assert.equal(verifyConsoleSession(token + "changed", "owner-secret-1", now, group), false);
  assert.equal(verifyConsoleSession("../../", "owner-secret-1", now, group), false);
  assert.notEqual(consoleCookieName(group), consoleCookieName(personal));
  assert.ok(!token.includes("owner-secret"));
});

function consoleAuthCookie(ownerToken: string, publicBaseUrl: string): string {
  const audience = consoleSessionAudience(publicBaseUrl);
  return `${consoleCookieName(publicBaseUrl)}=${createConsoleSession(ownerToken, Date.now(), audience)}`;
}

test("browser trace query stays owner-authenticated, bounded and read-only", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "synrex-console-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(dir);
  diagnostics.record("mcp_received", { requestId: "request-1" });
  diagnostics.record("mcp_finished", { requestId: "request-1", durationMs: 24, status: 200 });
  const app = express();
  const secret = "owner-test-token";
  const publicBaseUrl = "https://console.example.test";
  registerSynrexConsole(app, {
    stateDir: dir, publicBaseUrl,
    oauth: { ownerToken: secret },
  } as ServerConfig);
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise<void>((resolve,reject) =>
    server.close(error=>error?reject(error):resolve())));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/console/api/trace`;
  assert.equal((await fetch(base+"?requestId=request-1")).status, 401);
  const cookie = consoleAuthCookie(secret, publicBaseUrl);
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
  const app=express(),ownerToken="owner-test-secret",publicBaseUrl="https://console.example.test";
  registerSynrexConsole(app,{stateDir:dir,publicBaseUrl,
    oauth:{ownerToken}} as ServerConfig);
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/console/api`;
  const cookie=consoleAuthCookie(ownerToken, publicBaseUrl);
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
  const app=express(),ownerToken="owner-test-token",publicBaseUrl="https://console.example.test";
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const port=(server.address() as {port:number}).port;
  registerSynrexConsole(app,{stateDir:dir,port,publicBaseUrl,
    oauth:{ownerToken}} as ServerConfig);
  const response=await fetch(`http://127.0.0.1:${port}/console/api/login`,{
    method:"POST",headers:{origin:`http://127.0.0.1:${port}`,"content-type":"application/json"},
    body:JSON.stringify({password:ownerToken}),
  });
  assert.equal(response.status,200);
  const cookie=response.headers.get("set-cookie")??"";
  assert.match(cookie,new RegExp(`${consoleCookieName(publicBaseUrl)}=`));
  assert.doesNotMatch(cookie,/rev_console=/);
  assert.doesNotMatch(cookie,/; Secure/i);
});

test("console assets stay same-origin for local desktop and use the configured public base remotely", () => {
  const config={port:17677,publicBaseUrl:"https://dev.sanqi.org/group"} as ServerConfig;
  assert.equal(consoleAssetBase(config,"127.0.0.1:17677"),"/group/mcp-app-assets");
  assert.equal(consoleAssetBase(config,"localhost:17677"),"/group/mcp-app-assets");
  assert.equal(consoleAssetBase(config,"[::1]:17677"),"/group/mcp-app-assets");
  assert.equal(consoleAssetBase({...config,publicBaseUrl:"https://dev.sanqi.org/"},"127.0.0.1:17677"),"/mcp-app-assets");
  assert.equal(consoleAssetBase(config,"dev.sanqi.org"),"https://dev.sanqi.org/group/mcp-app-assets");
  assert.equal(consoleAssetBase(config,"evil.example.test"),"https://dev.sanqi.org/group/mcp-app-assets");
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
  const app=express(),ownerToken="owner-test-token",publicBaseUrl="https://console.example.test";
  registerSynrexConsole(app,{stateDir:dir,port:17677,publicBaseUrl,
    oauth:{ownerToken}} as ServerConfig,{windowsControlBaseUrl:"http://127.0.0.1:17678",fetchImpl:fakeFetch});
  const server=await new Promise<Server>(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/console/api/windows`;
  const cookie=consoleAuthCookie(ownerToken, publicBaseUrl);
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

test("owner-only HTTP snapshot exposes usage while unauthenticated clients are rejected", async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "synrex-console-http-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const db = openDatabase(stateDir); db.close();
  new CodingWorkflowStore(stateDir).close();
  const recorder = new UsageTrafficRecorder(stateDir);
  recorder.record({ event: "mcp_received", ts: new Date().toISOString(), requestId: "r1", inputBytes: 250 });
  assert.ok(recorder.flush()); recorder.close();
  await mkdir(path.join(stateDir,"observability"),{recursive:true});
  const snapshot=readConsoleSnapshot(stateDir,"test-release");
  const snapshotFile=path.join(stateDir,"observability","console-snapshot.json");
  await writeFile(snapshotFile,JSON.stringify(snapshot));
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
  const cookie=consoleAuthCookie(ownerToken, config.publicBaseUrl);
  const response=await fetch(endpoint,{headers:{cookie}});
  assert.equal(response.status,200);
  const payload=await response.json() as {usage:{periods:{"24h":{requests:number;inputBytes:number}}};snapshotStale:boolean};
  assert.equal(payload.snapshotStale,false);
  assert.equal(payload.usage.periods["24h"].requests,1);
  assert.equal(payload.usage.periods["24h"].inputBytes,250);
  await writeFile(snapshotFile,JSON.stringify({...snapshot,sourceHealth:{available:false,unavailable:["devspace.sqlite:read_failed"]}}));
  const degraded=await fetch(endpoint,{headers:{cookie}});
  assert.equal(degraded.status,200);
  assert.equal((await degraded.json() as {snapshotStale:boolean}).snapshotStale,true);
  // A broken or missing collector artifact must never synchronously scan
  // SQLite/logs inside the live MCP process.
  await writeFile(snapshotFile,"{");
  assert.equal((await fetch(endpoint,{headers:{cookie}})).status,503);
  await rm(snapshotFile);
  assert.equal((await fetch(endpoint,{headers:{cookie}})).status,503);
});
