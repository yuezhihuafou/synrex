import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateTokenHistory, tokenHistorySummary } from "./console-token-history.js";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

const now=new Date("2026-10-28T12:10:00.000Z");
const e=(event:DiagnosticEntry["event"],ts:string,fields:Partial<DiagnosticEntry>={})=>
  JSON.stringify({event,ts,requestId:"req1",...fields})+"\n";

test("persistent Token ledger does not replay, survives restart/rotation and retains peaks",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-token-ledger-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const logs=path.join(dir,"diagnostics");await mkdir(logs);
  const current=path.join(logs,"recent.jsonl");
  await writeFile(current,
    e("tool_execution_started","2026-10-28T12:09:00Z")+
    e("tool_tokens_measured","2026-10-28T12:09:02Z",{inputTokens:24})+
    e("tool_tokens_measured","2026-10-28T12:09:04Z",{outputTokens:180}));
  let data=updateTokenHistory(dir,now);
  assert.equal(data.totals.input,24);
  assert.equal(data.totals.output,180);
  assert.equal(data.totals.calls,1);
  assert.equal(data.peakMinute?.tokensPerSecond,3);
  data=updateTokenHistory(dir,new Date(now.getTime()+15000));
  assert.equal(data.totals.output,180,"same bytes should not replay");

  await rename(current,current+".1");
  await writeFile(current,e("tool_tokens_measured","2026-10-28T12:09:40Z",{outputTokens:300}));
  data=updateTokenHistory(dir,new Date(now.getTime()+30000));
  assert.equal(data.totals.output,480);
  assert.equal(data.peakMinute?.tokensPerSecond,8);
  assert.equal(data.peakOutputCall?.tokens,300);
  const partial=e("tool_tokens_measured","2026-10-28T12:10:00Z",{outputTokens:55});
  await appendFile(current,partial.slice(0,-1));
  assert.equal(updateTokenHistory(dir,new Date(now.getTime()+45000)).totals.output,480);
  await appendFile(current,"\n");
  data=updateTokenHistory(dir,new Date(now.getTime()+60000));
  assert.equal(data.totals.output,535);
  assert.equal(data.peakMinute?.tokens,480);
  assert.equal(data.gaps,0);
  const publicData=tokenHistorySummary(data);
  assert.equal(publicData.totals.outputTokens,535);
  assert.equal(publicData.observedFrom,"2026-10-28T12:09:00.000Z");
  assert.equal(publicData.hour.length,1);
  assert.equal(publicData.day.length,1);
  assert.equal(tokenHistorySummary(updateTokenHistory(dir,new Date(now.getTime()+75000))).totals.outputTokens,535);
  assert.ok((await readFile(path.join(dir,"observability","token-history.json"),"utf8")).includes("peakMinute"));
});

test("detected log gaps are explicit and damaged history is not reset to zero",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-token-ledger-gap-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,"diagnostics"));
  const file=path.join(dir,"diagnostics","recent.jsonl");
  await writeFile(file,e("tool_tokens_measured","2026-10-28T12:09:00Z",{outputTokens:100}));
  assert.equal(updateTokenHistory(dir,now).totals.output,100);
  await rm(file);
  await writeFile(file,e("tool_tokens_measured","2026-10-28T12:09:30Z",{outputTokens:40}));
  const later=updateTokenHistory(dir,new Date(now.getTime()+15000));
  assert.equal(later.totals.output,140);
  assert.equal(later.gaps,1);
  const history=path.join(dir,"observability","token-history.json");
  await writeFile(history,"{broken");
  assert.throws(()=>updateTokenHistory(dir,new Date(now.getTime()+30000)));
  assert.equal(await readFile(history,"utf8"),"{broken");
});

test("runtime-average throughput pairs Token-worker output with completed HTTP durations across snapshots",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-runtime-throughput-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const logs=path.join(dir,"diagnostics");await mkdir(logs);
  const file=path.join(logs,"recent.jsonl");
  const at=(id:string,event:DiagnosticEntry["event"],ts:string,fields:Partial<DiagnosticEntry>={})=>
    JSON.stringify({event,ts,requestId:id,...fields})+"\n";
  await writeFile(file,
    at("a","mcp_finished","2026-10-28T12:09:04Z",{durationMs:3000})+
    at("b","tool_tokens_measured","2026-10-28T12:09:04Z",{outputTokens:300})+
    at("skip","tool_tokens_measured","2026-10-28T12:09:04Z",{outputTokens:500}));
  let h=tokenHistorySummary(updateTokenHistory(dir,now));
  assert.equal(h.runtime.averageTokensPerSecond,null,"unmatched calls cannot claim a throughput");
  assert.equal(h.totals.outputTokens,800,"unpaired counts stay in the usual cumulative total");

  // Outputs and finish events may arrive in either order and across timer runs.
  await appendFile(file,
    at("a","tool_tokens_measured","2026-10-28T12:09:10Z",{outputTokens:200})+
    at("b","mcp_finished","2026-10-28T12:09:12Z",{durationMs:2000})+
    at("zero","mcp_finished","2026-10-28T12:09:12Z",{durationMs:0,outputTokens:100}));
  h=tokenHistorySummary(updateTokenHistory(dir,new Date(now.getTime()+15000)));
  assert.equal(h.runtime.averageTokensPerSecond,100,"500 output tokens / 5 observed seconds");
  assert.deepEqual({calls:h.runtime.measuredCalls,tokens:h.runtime.matchedOutputTokens,ms:h.runtime.matchedDurationMs},
    {calls:2,tokens:500,ms:5000});
  assert.equal(h.minute[0]?.runtimeAverageTokensPerSecond,100);
  assert.equal(h.minute[0]?.runtimeSamples,2);
  assert.equal(h.runtime.observedFrom,"2026-10-28T12:09:04.000Z");

  await rename(file,file+".1");
  await writeFile(file,at("a","mcp_finished","2026-10-28T12:09:40Z",{durationMs:3000})+
    at("a","tool_tokens_measured","2026-10-28T12:09:41Z",{outputTokens:200})+
    at("legacy","mcp_finished","2026-10-28T12:09:45Z",{durationMs:1000,outputTokens:100}));
  h=tokenHistorySummary(updateTokenHistory(dir,new Date(now.getTime()+30000)));
  assert.equal(h.runtime.measuredCalls,3,"duplicate request ID never double counts matched runtime");
  assert.equal(h.runtime.averageTokensPerSecond,100);
  assert.equal(tokenHistorySummary(updateTokenHistory(dir,new Date(now.getTime()+45000))).runtime.measuredCalls,3);
});

test("upgrading an existing ledger adds runtime stats without resetting historical Token totals",async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),"synrex-runtime-upgrade-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,"observability"));
  await mkdir(path.join(dir,"diagnostics"));
  const file=path.join(dir,"diagnostics","recent.jsonl");
  await writeFile(file,e("tool_tokens_measured","2026-10-28T12:09:02Z",{outputTokens:150}));
  const old=updateTokenHistory(dir,now);
  assert.equal(old.totals.output,150);
  await appendFile(file,e("mcp_finished","2026-10-28T12:09:05Z",{durationMs:3000}));
  const upgraded=tokenHistorySummary(updateTokenHistory(dir,new Date(now.getTime()+15000)));
  assert.equal(upgraded.totals.outputTokens,150);
  assert.equal(upgraded.runtime.averageTokensPerSecond,50);
  assert.equal(upgraded.runtime.measuredCalls,1);
});

test("correlated concurrent MCP calls retain union metrics across timer restart and log rotation",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"synrex-effective-ledger-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,"diagnostics"));
  const file=path.join(root,"diagnostics","recent.jsonl");
  const events=(id:string,conversation:string|undefined,ms:number,output:number)=>[
    {event:"mcp_received",requestId:id,ts:new Date(now.getTime()-ms).toISOString()},
    {event:"mcp_body_ready",requestId:id,rpcMethod:"tools/call",ts:new Date(now.getTime()-ms+1).toISOString()},
    {event:"tool_execution_started",requestId:id,ts:new Date(now.getTime()-ms+2).toISOString()},
    ...(conversation?[{event:"conversation_seen",requestId:id,conversationId:conversation,ts:new Date(now.getTime()-ms+2).toISOString()}]:[]),
    {event:"mcp_finished",requestId:id,durationMs:ms,ts:now.toISOString()},
    {event:"tool_tokens_measured",requestId:id,outputTokens:output,ts:new Date(now.getTime()+1).toISOString()},
  ].map(e=>JSON.stringify(e)+"\n").join("");
  const conv="conv_"+"a".repeat(32);
  await writeFile(file,events("a",conv,4000,1000)+events("b",conv,2000,1000)+events("unknown",undefined,4000,90000));
  let s=tokenHistorySummary(updateTokenHistory(root,new Date(now.getTime()+15000)));
  assert.equal(s.effective.matchedCalls,2);
  assert.equal(s.effective.unknownCalls,1);
  assert.equal(s.effective.perSessionActiveMs,4000);
  assert.equal(s.effective.perSessionTokensPerSecond,500);
  assert.equal(s.effective.globalActiveTokensPerSecond,500);
  assert.equal(s.effective.outputTokens,2000);
  await rename(file,file+".1");await writeFile(file,"");
  s=tokenHistorySummary(updateTokenHistory(root,new Date(now.getTime()+30000)));
  assert.equal(s.effective.matchedCalls,2);
  assert.equal(s.effective.unknownCalls,1);
  assert.equal(s.totals.outputTokens,92000);
});
