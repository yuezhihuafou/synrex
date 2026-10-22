import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readArchivedTrace, historyStats, searchArchive } from "./observability-history.js";
import { spanPayload } from "./native-otel.js";
import { newOtelContext } from "./otel-context.js";

const indexer=fileURLToPath(new URL("../deploy/observability/archive-indexer.mjs",import.meta.url));
function record(ts:string,id:string){
  return JSON.stringify({resourceLogs:[{resource:{attributes:[{key:"synrex.node.id",value:{stringValue:"swy1"}}]},
    scopeLogs:[{logRecords:[{attributes:[
      {key:"event",value:{stringValue:"mcp_finished"}},
      {key:"ts",value:{stringValue:ts}},
      {key:"requestId",value:{stringValue:id}},
      {key:"otelTraceId",value:{stringValue:"abcdef0123456789abcdef0123456789"}},
      {key:"status",value:{intValue:"200"}},
      {key:"private_prompt",value:{stringValue:"must-not-be-saved"}},
    ]}]}]}]})+"\n";
}
test("seven-day index survives file rotation/restart and rejects unexpected content",t=>{
  const root=mkdtempSync(path.join(tmpdir(),"synrex-history-test-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,"observability","data");mkdirSync(dir,{recursive:true});
  const now=new Date().toISOString();
  const old=new Date(Date.now()-8*86400000).toISOString();
  const first=path.join(dir,"logs.otlp.json");
  writeFileSync(first,record(now,"request-a")+record(old,"expired"));
  function scan(){
    const r=spawnSync(process.execPath,[indexer,"scan"],{
      env:{...process.env,SYNREX_STATE_DIR:root,NODE_OPTIONS:"--no-warnings"},
      encoding:"utf8",timeout:12000});
    assert.equal(r.status,0,r.stderr);
  }
  scan();scan();
  assert.equal(historyStats(root).events,1,"old records are pruned and restarts must not duplicate");
  renameSync(first,path.join(dir,"logs.otlp-rotated.json"));
  writeFileSync(first,record(now,"request-b"));
  scan();
  assert.equal(historyStats(root).events,2);
  assert.deepEqual(searchArchive(root,{event:"mcp_finished"}).map(e=>e.requestId).sort(),["request-a","request-b"]);
  const traced=readArchivedTrace(root,"request-a");
  assert.equal(traced.events.length,1);
  assert.equal(traced.events[0]?.otelTraceId,"abcdef0123456789abcdef0123456789");
  assert.ok(!JSON.stringify(traced).includes("must-not-be-saved"));
  const ctx=newOtelContext();
  appendFileSync(path.join(dir,"traces.otlp.json"),JSON.stringify(spanPayload({
    context:ctx,name:"mcp.http",startMs:Date.now()-7,endMs:Date.now(),status:"ok",
    fields:{"synrex.request_id":"request-c"},
  }))+"\n");
  scan();
  assert.equal(historyStats(root).spans,1);
  assert.equal(readArchivedTrace(root,ctx.otelTraceId).spans[0]?.spanId,ctx.otelSpanId);
  // A backlog of multiline OTLP JSONL records is ingested in one pass.
  appendFileSync(first,Array.from({length:300},(_,i)=>record(now,"queue-"+i)).join(""));
  scan();
  assert.equal(historyStats(root).events,302);
  scan();
  assert.equal(historyStats(root).events,302);
});
