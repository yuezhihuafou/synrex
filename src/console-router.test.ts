import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleAssetBasePath, consoleSessionScope, createConsoleSession, verifyConsoleSession } from "./console-router.js";
import { registerSynrexConsole } from "./console-router.js";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
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
  const scope = "origin=http://127.0.0.1:17677\nrevision=release-a";
  const token = createConsoleSession("owner-secret-1", scope, now);
  assert.ok(verifyConsoleSession(token, "owner-secret-1", scope, now));
  assert.equal(verifyConsoleSession(token, "owner-secret-2", scope, now), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", scope, now + 9 * 60 * 60_000), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", "different-deployment", now), false);
  assert.equal(verifyConsoleSession(token + "changed", "owner-secret-1", scope, now), false);
  assert.equal(verifyConsoleSession("../../", "owner-secret-1", scope, now), false);
  assert.match(token, /^2\./);
  assert.ok(!token.includes("owner-secret"));
});

test("console session scope changes with deployment identity and browser origin", () => {
  const config = { publicBaseUrl: "https://console.example.test/server", stateDir: "/state/a" };
  const original = consoleSessionScope(config as ServerConfig, "http://127.0.0.1:17677", "a".repeat(40));
  assert.notEqual(original,
    consoleSessionScope(config as ServerConfig, "http://127.0.0.1:17677", "b".repeat(40)));
  assert.notEqual(original,
    consoleSessionScope({ ...config, stateDir: "/state/b" } as ServerConfig, "http://127.0.0.1:17677", "a".repeat(40)));
  assert.notEqual(original,
    consoleSessionScope(config as ServerConfig, "https://console.example.test", "a".repeat(40)));
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
  const localOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const base = `${localOrigin}/console/api/trace`;
  assert.equal((await fetch(base+"?requestId=request-1")).status, 401);
  const scope=consoleSessionScope({stateDir:dir,publicBaseUrl:"https://console.example.test"} as ServerConfig,
    localOrigin);
  const cookie = "rev_console="+createConsoleSession(secret,scope);
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
  const localOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const base=`${localOrigin}/console/api`;
  const scope=consoleSessionScope({stateDir:dir,publicBaseUrl:"https://console.example.test"} as ServerConfig,
    localOrigin);
  const cookie="rev_console="+createConsoleSession(ownerToken,scope);
  const body=JSON.stringify({requestId:"req-0001",conversationTitle:"评估全链路日志"});
  const send=(id:string,headers:Record<string,string>,json=body)=>fetch(base+id,{
    method:"POST",headers:{"content-type":"application/json",...headers},body:json,
  });
  assert.equal((await send("/conversation-label",{"origin":localOrigin})).status,401);
  assert.equal((await send("/conversation-label",{cookie,origin:"https://evil.example.test"})).status,403);
  assert.equal((await send("/conversation-label",{cookie,origin:localOrigin},
    JSON.stringify({requestId:"not-present",conversationTitle:"Title"}))).status,404);
  assert.equal((await send("/conversation-label",{cookie,origin:localOrigin})).status,200);
  const trace=await fetch(base+"/trace?requestId=req-0001",{headers:{cookie}});
  const detail=await trace.json() as {conversationTitle:string;titleSource:string};
  assert.equal(detail.conversationTitle,"评估全链路日志");
  assert.equal(detail.titleSource,"owner");
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
  const scope=consoleSessionScope(config,`http://127.0.0.1:${port}`);
  const response=await fetch(endpoint,{headers:{cookie:`rev_console=${createConsoleSession(ownerToken,scope)}`}});
  assert.equal(response.status,200);
  const payload=await response.json() as {usage:{periods:{"24h":{requests:number;inputBytes:number}}};snapshotStale:boolean};
  assert.equal(payload.snapshotStale,false);
  assert.equal(payload.usage.periods["24h"].requests,1);
  assert.equal(payload.usage.periods["24h"].inputBytes,250);
  await writeFile(snapshotFile,JSON.stringify({...snapshot,sourceHealth:{available:false,unavailable:["devspace.sqlite:read_failed"]}}));
  const degraded=await fetch(endpoint,{headers:{cookie:`rev_console=${createConsoleSession(ownerToken,scope)}`}});
  assert.equal(degraded.status,200);
  assert.equal((await degraded.json() as {snapshotStale:boolean}).snapshotStale,true);
  // A broken or missing collector artifact must never synchronously scan
  // SQLite/logs inside the live MCP process.
  await writeFile(snapshotFile,"{");
  assert.equal((await fetch(endpoint,{headers:{cookie:`rev_console=${createConsoleSession(ownerToken,scope)}`}})).status,503);
  await rm(snapshotFile);
  assert.equal((await fetch(endpoint,{headers:{cookie:`rev_console=${createConsoleSession(ownerToken,scope)}`}})).status,503);
});

test("authenticated browser extension API serves the packaged archive", async t => {
  const stateDir=await mkdtemp(path.join(tmpdir(),"synrex-console-extension-"));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const app=express(),ownerToken="extension-owner-secret";
  const config={stateDir,publicBaseUrl:"http://127.0.0.1:12345",oauth:{ownerToken}} as ServerConfig;
  registerSynrexConsole(app,config);
  const server=app.listen(0,"127.0.0.1");
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const port=(server.address() as {port:number}).port;
  const origin=`http://127.0.0.1:${port}`;
  const scope=consoleSessionScope(config,origin);
  const cookie=`rev_console=${createConsoleSession(ownerToken,scope)}`;
  const response=await fetch(origin+"/console/api/browser-extension",{headers:{cookie}});
  assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get("content-disposition")??"",/synrex-browser-observer\.zip/);
  assert.ok((await response.arrayBuffer()).byteLength>1000);
});

test("loopback Console uses same-origin assets and local session cookies while public sessions stay secure", async t => {
  const stateDir=await mkdtemp(path.join(tmpdir(),"synrex-console-local-"));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const ownerToken="local-owner-secret";
  const config={stateDir,publicBaseUrl:"https://console.example.test/server",oauth:{ownerToken}} as ServerConfig;
  const app=express();registerSynrexConsole(app,config);
  const server=app.listen(0,"127.0.0.1");
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const port=(server.address() as {port:number}).port;
  const localOrigin=`http://127.0.0.1:${port}`;

  assert.equal(consoleAssetBasePath(config.publicBaseUrl),"/server/mcp-app-assets");
  const stale=await fetch(localOrigin+"/console/api/session",{headers:{cookie:"rev_console=legacy-session"}});
  assert.equal(stale.status,401);
  assert.match(stale.headers.get("set-cookie")??"",/rev_console=/);

  const rejected=await fetch(localOrigin+"/console/api/login",{
    method:"POST",headers:{origin:"https://evil.example.test","content-type":"application/json"},
    body:JSON.stringify({password:ownerToken}),
  });
  assert.equal(rejected.status,403);

  const localLogin=await fetch(localOrigin+"/console/api/login",{
    method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},
    body:JSON.stringify({password:ownerToken}),
  });
  assert.equal(localLogin.status,200,await localLogin.clone().text());
  const localSetCookie=localLogin.headers.get("set-cookie")??"";
  assert.match(localSetCookie,/HttpOnly/i);assert.match(localSetCookie,/SameSite=Strict/i);
  assert.ok(!/;\s*Secure/i.test(localSetCookie));
  const localCookie=localSetCookie.split(";",1)[0]!;
  assert.equal((await fetch(localOrigin+"/console/api/session",{headers:{cookie:localCookie}})).status,200);

  const publicLogin=await new Promise<{status:number;setCookie:string}>((resolve,reject)=>{
    const body=JSON.stringify({password:ownerToken});
    const req=httpRequest({hostname:"127.0.0.1",port,path:"/console/api/login",method:"POST",headers:{
      host:"console.example.test",origin:"https://console.example.test","content-type":"application/json",
      "content-length":Buffer.byteLength(body),
    }},res=>{res.resume();res.on("end",()=>resolve({status:res.statusCode??0,setCookie:res.headers["set-cookie"]?.join(";")??""}));});
    req.on("error",reject);req.end(body);
  });
  assert.equal(publicLogin.status,200);
  assert.match(publicLogin.setCookie,/;\s*Secure/i);
  const replay=await new Promise<number>((resolve,reject)=>{
    const req=httpRequest({hostname:"127.0.0.1",port,path:"/console/api/session",headers:{
      host:"console.example.test",cookie:localCookie,
    }},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});
    req.on("error",reject);req.end();
  });
  assert.equal(replay,401,"loopback session must not replay against the public Console origin");
});
