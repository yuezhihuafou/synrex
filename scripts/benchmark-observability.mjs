#!/usr/bin/env node
// Controlled, repeatable loopback HTTP middleware microbenchmark; it does NOT
// represent ChatGPT/model latency or a whole cross-node tool invocation.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import express from "express";

const baseline=process.argv[2],candidate=process.argv[3];
if(!baseline||!candidate)throw Error("Usage: benchmark-observability.mjs BASELINE_RELEASE CANDIDATE_RELEASE");
const temp=mkdtempSync(path.join(tmpdir(),"synrex-otel-benchmark-"));
const apps=[];
async function setup(label,root) {
  const module=await import(pathToFileURL(path.join(root,"dist","http-trace.js")).href);
  const diagnostics=await import(pathToFileURL(path.join(root,"dist","diagnostic-trace.js")).href);
  const app=express(), config={logging:{requests:false,assets:false,trustProxy:false}};
  app.use(module.requestTraceMiddleware(config,new diagnostics.DiagnosticTrace(path.join(temp,label)),()=>({})));
  app.post("/mcp",(_req,res)=>res.status(200).json({ok:true}));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  apps.push(server);
  return {label,url:`http://127.0.0.1:${server.address().port}/mcp`,latencies:[]};
}
const tests=[];
try{
  tests.push(await setup("baseline",baseline),await setup("candidate",candidate));
  async function send(t) {
    const start=performance.now();
    const r=await fetch(t.url,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/list"})});
    if(!r.ok)throw Error("Probe response not ok");
    await r.arrayBuffer();
    return performance.now()-start;
  }
  for(let warm=0;warm<20;warm++)for(const t of tests)await send(t);
  for(let pass=0;pass<5;pass++){
    for(let i=0;i<50;i++){
      const order=(pass+i)%2?[tests[1],tests[0]]:tests;
      for(const t of order)t.latencies.push(await send(t));
    }
  }
  function summarize(t){
    const sorted=t.latencies.sort((a,b)=>a-b);
    const at=p=>Math.round(sorted[Math.floor(p*(sorted.length-1))]*100)/100;
    return {label:t.label,samples:sorted.length,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99)};
  }
  console.log(JSON.stringify({kind:"isolated_loopback_http_middleware_not_full_mcp",
    comparedAgainst:baseline,candidate,result:tests.map(summarize)},null,2));
}finally{
  await Promise.all(apps.map(s=>new Promise(resolve=>s.close(resolve))));
  rmSync(temp,{recursive:true,force:true});
}
