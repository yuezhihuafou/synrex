import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StatisticsStore } from "./statistics.js";
import { ExecutionReader } from "./executions.js";
import { MonitorCollector } from "./collector.js";
import { createMonitorApp } from "./server.js";
import { DurableTaskManager } from "../durable-tasks.js";
import type { DiagnosticEntry } from "../diagnostic-trace.js";
import { parseProcStat } from "./resources.js";

async function fixture(t: { after: (fn:()=>unknown)=>void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "synrex-monitor-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const runs=path.join(dir,"runs"), state=path.join(dir,"state"), project=path.join(dir,"project");
  await Promise.all([mkdir(runs),mkdir(state),mkdir(project)]);
  return {dir,runs,state,project};
}
function event(event:DiagnosticEntry["event"], requestId:string, fields:Partial<DiagnosticEntry>={}):DiagnosticEntry {
  return {ts:new Date().toISOString(),event,requestId,tool:"exec_command",workspaceId:"ws_test",...fields};
}

test("persistent statistics deduplicate replay, count tool errors under HTTP 200, filter and preserve exact percentiles",async t=>{
  const f=await fixture(t), file=path.join(f.dir,"monitor","stats.sqlite");
  let store=new StatisticsStore(file);
  const rows=[event("mcp_received","req_a"),event("tool_execution_finished","req_a",{outcome:"error"}),event("mcp_finished","req_a",{status:200,durationMs:100}),event("mcp_received","req_b"),event("mcp_finished","req_b",{status:200,durationMs:300}),event("mcp_received","req_c",{tool:"read"})];
  store.ingest(rows);store.ingest(rows);
  let q=store.query({minutes:60});
  assert.deepEqual(q.requests,{count:3,ok:1,errors:1,incomplete:1,latencyCount:2,p50:100,p95:300});
  assert.equal(store.query({minutes:60,tool:"read"}).requests.count,1);
  assert.equal(store.query({minutes:60,workspace:"ws_other"}).requests.count,0);
  const started=q.observationStartedAt;store.close();store=new StatisticsStore(file);t.after(()=>store.close());store.ingest(rows);
  q=store.query({minutes:60});assert.equal(q.requests.count,3);assert.equal(q.observationStartedAt,started);
});

test("incremental trace import survives partial writes, rename rotation and restart without lost or double counts",async t=>{
  const f=await fixture(t), diagnostics=path.join(f.state,"diagnostics");await mkdir(diagnostics);
  const file=path.join(diagnostics,"recent.jsonl"), db=path.join(f.dir,"monitor","stats.sqlite");
  const a=JSON.stringify(event("mcp_finished","req_a",{durationMs:10,status:200}));
  await writeFile(file,a.slice(0,40));let store=new StatisticsStore(db);
  await store.collectDiagnostics(f.state);assert.equal(store.query({minutes:60}).requests.count,0);
  await writeFile(file,a+"\n");await store.collectDiagnostics(f.state);assert.equal(store.query({minutes:60}).requests.count,1);
  await rename(file,file+".1");await writeFile(file,JSON.stringify(event("mcp_finished","req_b",{durationMs:20,status:200}))+"\n");
  await store.collectDiagnostics(f.state);assert.equal(store.query({minutes:60}).requests.count,2);store.close();
  store=new StatisticsStore(db);t.after(()=>store.close());await store.collectDiagnostics(f.state);assert.equal(store.query({minutes:60}).requests.count,2);
});

test("bounded output rejects symlink escape and readonly management",async t=>{
  const f=await fixture(t), run="run_20261022000000_abc", dir=path.join(f.runs,"2026-10-22",run);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,"task.json"),JSON.stringify({runId:run,taskId:"task_1234567812345678",root:f.project,cwd:f.project,workspaceId:"ws_test",command:"test",createdAt:new Date().toISOString(),status:"working",outputBytes:0}));
  await writeFile(path.join(dir,"output.log"),"x".repeat(100_000));
  const reader=new ExecutionReader(f.runs);await reader.sample();const output=await reader.output(run);assert.equal(Buffer.byteLength(output.text),65536);assert.equal(output.truncated,true);
  await assert.rejects(()=>reader.cancel(run),/disabled/);
  await rm(path.join(dir,"output.log"));await writeFile(path.join(f.dir,"secret"),"private");await symlink(path.join(f.dir,"secret"),path.join(dir,"output.log"));
  await assert.rejects(()=>reader.output(run));assert.equal(await readFile(path.join(f.dir,"secret"),"utf8"),"private");
});

test("HTTP login, stream, CSRF rejection, read-only cancellation and diagnostic export",async t=>{
  const f=await fixture(t), collector=new MonitorCollector({stateDir:f.state,runRoot:f.runs,database:path.join(f.dir,"monitor","stats.sqlite")});
  t.after(()=>collector.stop());
  const app=createMonitorApp({collector,password:"test-owner-password-123",publicOrigin:"http://localhost:4318",assets:f.dir});
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address() as {port:number}, base=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base+"/console/api/snapshot")).status,401);
  const login=await fetch(base+"/console/api/login",{method:"POST",headers:{Origin:"http://localhost:4318","Content-Type":"application/json"},body:JSON.stringify({password:"test-owner-password-123"})});assert.equal(login.status,200);
  const cookie=login.headers.get("set-cookie")!.split(";")[0];
  const snapshot=await fetch(base+"/console/api/snapshot",{headers:{cookie}});assert.equal(snapshot.status,200);assert.ok((await snapshot.json()).resources.processes.length);
  const abort=new AbortController();const stream=await fetch(base+"/console/api/events",{headers:{cookie},signal:abort.signal});assert.equal(stream.status,200);const reader=stream.body!.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: snapshot/);abort.abort();
  const secondAbort=new AbortController();const secondStream=await fetch(base+"/console/api/events",{headers:{cookie},signal:secondAbort.signal});
  const secondReader=secondStream.body!.getReader();await secondReader.read();
  await collector.sample();let patch="";for(let i=0;i<4&&!patch.includes("event: patch");i++)patch+=new TextDecoder().decode((await secondReader.read()).value);
  assert.match(patch,/event: patch/);assert.match(patch,/"changed":/);secondAbort.abort();
  const action=await fetch(base+"/console/api/cancel/run_test",{method:"POST",headers:{cookie,Origin:"http://evil.example","Content-Type":"application/json","Idempotency-Key":"test-key-123"},body:"{}"});assert.equal(action.status,403);
  const denied=await fetch(base+"/console/api/cancel/run_test",{method:"POST",headers:{cookie,Origin:"http://localhost:4318","Content-Type":"application/json","Idempotency-Key":"test-key-123"},body:"{}"});assert.equal(denied.status,409);
  assert.equal((await fetch(base+"/console/api/export",{headers:{cookie}})).status,200);
});

test("real detached task is visible, output follows, cancel reaches terminal receipt without changing core",async t=>{
  const f=await fixture(t);let runner:ReturnType<typeof spawn>|undefined;
  const manager=new DurableTaskManager({runRoot:f.runs,systemdAvailable:()=>false,launchTask:async({requestPath})=>{
    runner=spawn(process.execPath,["--import","tsx",path.resolve("src/durable-task-runner.ts"),requestPath],{detached:true,stdio:"ignore"});runner.unref();
  }});
  t.after(()=>{if(runner?.pid)try{process.kill(-runner.pid,"SIGTERM");}catch{}});
  const task=await manager.start({workspaceId:"ws_test",workspaceRoot:f.project,cwd:f.project,command:`exec ${process.execPath} -e 'console.log("monitor-test-start");setInterval(()=>console.log("tick"),250)'`},1000);
  const reader=new ExecutionReader(f.runs,[f.project]);let rows=(await reader.sample()).executions;assert.equal(rows[0].status,"working");assert.equal(rows[0].canCancel,true);assert.match((await reader.output(task.runId)).text,/monitor-test-start/);
  const result=await reader.cancel(task.runId);assert.equal(result.status,"cancel_requested");
  for(let i=0;i<40;i++){rows=(await reader.sample()).executions;if(rows[0].status==="cancelled")break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(rows[0].status,"cancelled");assert.equal(rows[0].canCancel,false);
});

test("Linux stat parser handles spaces and parentheses in process name",()=>{
  const fields=Array(50).fill("0");fields[0]="S";fields[1]="42";fields[11]="200";fields[12]="50";fields[19]="1234";fields[21]="10";
  const parsed=parseProcStat(`123 (worker (job)) ${fields.join(" ")}`);assert.equal(parsed.row.name,"worker (job)");assert.equal(parsed.row.ppid,42);assert.equal(parsed.ticks,250);assert.equal(parsed.row.rssBytes,40960);
});
