import test from "node:test";
import assert from "node:assert/strict";
import {summarizeEffectiveThroughput,unionMilliseconds} from "./console-effective-throughput.js";

const t=Date.parse("2026-10-28T12:00:00Z");
test("overlapping calls count once per conversation; global concurrency is separate",()=>{
  const rows=[
    {requestId:"a",conversationId:"conv_aaa",startMs:t-8000,endMs:t-4000,outputTokens:1000},
    {requestId:"b",conversationId:"conv_aaa",startMs:t-6000,endMs:t-2000,outputTokens:1000},
    {requestId:"c",conversationId:"conv_bbb",startMs:t-7000,endMs:t-3000,outputTokens:1000},
    {requestId:"unknown",startMs:t-7000,endMs:t-3000,outputTokens:90000},
  ];
  const r=summarizeEffectiveThroughput(rows,t);
  assert.equal(r.perSessionActiveMs,10000); // 6 seconds plus 4 seconds
  assert.equal(r.globalActiveMs,6000);
  assert.equal(r.maxConcurrency,3);
  assert.equal(r.outputTokens,3000);
  assert.equal(r.perSessionTokensPerSecond,300);
  assert.equal(r.globalActiveTokensPerSecond,500);
  assert.equal(r.unknownCalls,1);
  assert.equal(r.attributionCoveragePercent,75);
  assert.equal(r.sessions.length,2);
  const a=r.sessions.find(s=>s.conversationId==="conv_aaa");
  const b=r.sessions.find(s=>s.conversationId==="conv_bbb");
  assert.deepEqual([a?.matchedCalls,a?.outputTokens,a?.activeMs,a?.activeTokensPerSecond],[2,2000,6000,333.3]);
  assert.deepEqual([b?.matchedCalls,b?.outputTokens,b?.activeMs,b?.activeTokensPerSecond],[1,1000,4000,250]);
  assert.equal(r.perSessionTokensPerSecond,300,"aggregate rate must not be mislabelled as any individual conversation");
});

test("serial intervals sum; absent verified association cannot produce a main GPT rate",()=>{
  assert.equal(unionMilliseconds([{startMs:1,endMs:2001},{startMs:2001,endMs:4001}]),4000);
  const r=summarizeEffectiveThroughput([{requestId:"x",startMs:t-1000,endMs:t,outputTokens:2500}],t);
  assert.equal(r.perSessionTokensPerSecond,null);
  assert.equal(r.globalActiveTokensPerSecond,null);
  assert.equal(r.status,"unavailable");
});
