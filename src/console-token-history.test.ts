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
