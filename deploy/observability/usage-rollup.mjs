#!/usr/bin/env node
// Separate low-priority process. No model calls, message bodies or main-loop work.
import { DatabaseSync } from "node:sqlite";
import { readFileSync,writeFileSync,renameSync,mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root=process.env.SYNREX_STATE_DIR;
if(!root||!path.isAbsolute(root))throw Error("SYNREX_STATE_DIR required");
const dir=path.join(root,"observability"),db=new DatabaseSync(path.join(dir,"history.sqlite"),{readOnly:true});
const since=new Date(Date.now()-7*86400000).toISOString();
const rows=db.prepare("SELECT event,request_id,ts,data FROM events WHERE ts>=? AND event IN ('mcp_received','mcp_finished','mcp_failed','mcp_closed_early','tool_execution_finished') ORDER BY ts").all(since);
const calls=new Map();
for(const row of rows){
  if(!row.request_id)continue;
  const record=calls.get(row.request_id)??{id:row.request_id,inputBytes:null,outputBytes:null,wallMs:null,toolCalls:0,status:"incomplete"};
  const data=JSON.parse(row.data);
  if(row.event==="mcp_received"&&Number.isFinite(data.inputBytes))record.inputBytes=data.inputBytes;
  if(row.event==="mcp_finished"){
    record.status="completed";
    if(Number.isFinite(data.outputBytes))record.outputBytes=data.outputBytes;
    if(Number.isFinite(data.durationMs))record.wallMs=data.durationMs;
  }
  if(row.event==="mcp_failed"||row.event==="mcp_closed_early")record.status="failed";
  if(row.event==="tool_execution_finished")record.toolCalls++;
  calls.set(row.request_id,record);
}
const all=[...calls.values()],sum=(key)=>all.reduce((n,x)=>n+(x[key]??0),0);
// The MCP wire includes JSON envelopes, not model tokens. Report bytes and
// explicitly labeled rough equivalents only; never present as token usage.
const bytesIn=sum("inputBytes"),bytesOut=sum("outputBytes");
const repo=process.env.SYNREX_REPO_ROOT;
let code=null;
if(repo){
  try{
    const output=execFileSync("git",["log","--since=7 days ago","--oneline","--numstat","--no-merges"],{
      cwd:repo,encoding:"utf8",timeout:5000,maxBuffer:4*1024*1024});
    let added=0,deleted=0,commits=0,files=0;
    for(const line of output.split("\n")){
      if(/^[0-9a-f]{7,40} /.test(line)){commits++;continue;}
      const m=/^(\d+)\t(\d+)\t/.exec(line);
      if(m){added+=Number(m[1]);deleted+=Number(m[2]);files++;}
    }
    code={commits,added,deleted,net:added-deleted,fileChanges:files,
      warning:"Git 提交统计，不等于 AI 独立贡献；包含人工修改和重复改写。"};
  }catch{}
}
const report={schema:"synrex.usage.v1",generatedAt:new Date().toISOString(),windowDays:7,
  requests:all.length,completed:all.filter(x=>x.status==="completed").length,
  failed:all.filter(x=>x.status==="failed").length,toolCalls:sum("toolCalls"),
  mcpWire:{inputBytes:bytesIn,outputBytes:bytesOut,observedInputRequests:all.filter(x=>x.inputBytes!==null).length,
    observedOutputRequests:all.filter(x=>x.outputBytes!==null).length},
  duration:{observedRequests:all.filter(x=>x.wallMs!==null).length,
    meanMs:all.some(x=>x.wallMs!==null)?Math.round(sum("wallMs")/all.filter(x=>x.wallMs!==null).length):null},
  modelTokens:{input:null,output:null,reason:"ChatGPT 宿主未提供 token usage；MCP 字节数不能代表模型上下文、推理或输出 token。"},
  comparison:{baseline:null,savingsPercent:null,reason:"缺少相同任务、模型、初始代码和测量口径的 GPT/Codex 对照。"},
  code};
mkdirSync(dir,{recursive:true});const file=path.join(dir,"usage-rollup.json");
writeFileSync(file+".tmp",JSON.stringify(report));renameSync(file+".tmp",file);
console.log(JSON.stringify({generatedAt:report.generatedAt,requests:report.requests}));
