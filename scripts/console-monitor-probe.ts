import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { percentile } from "../src/console-monitor/statistics.js";
const exec=promisify(execFile);
const base=process.argv[2]??"http://127.0.0.1:4318";
const auth=JSON.parse(await readFile(process.argv[3],"utf8"));
const unit=process.argv[4]??"synrex-console-monitor.service";
const login=await fetch(base+"/console/api/login",{method:"POST",headers:{Origin:new URL(base).origin,"Content-Type":"application/json"},body:JSON.stringify({password:auth.ownerToken})});
if(!login.ok)throw new Error(`Login failed: ${login.status}`);
const cookie=login.headers.get("set-cookie")!.split(";")[0];
const get=async()=>{const r=await fetch(base+"/console/api/snapshot",{headers:{cookie}});if(!r.ok)throw new Error(`Snapshot HTTP ${r.status}`);return r;};
async function usage(){const {stdout}=await exec("systemctl",["--user","show",unit,"-p","CPUUsageNSec","-p","MemoryCurrent","-p","NRestarts"]);return Object.fromEntries(stdout.trim().split("\n").map(x=>x.split("=")));}
const first=await usage(), started=performance.now();
const controller=new AbortController();
const stream=await fetch(base+"/console/api/events",{headers:{cookie},signal:controller.signal});
const reader=stream.body!.getReader();let streams=0, streamBytes=0;
const drain=(async()=>{try{while(true){const r=await reader.read();if(r.done)break;streams++;streamBytes+=r.value.byteLength;}}catch{}})();
const times:number[]=[], sampleMs:number[]=[], payloadBytes:number[]=[];
for(let i=0;i<12;i++){
  const start=performance.now(),r=await get(), text=await r.text();times.push(performance.now()-start);payloadBytes.push(Buffer.byteLength(text));sampleMs.push(JSON.parse(text).sampleMs);
  await new Promise(r=>setTimeout(r,2500));
}
controller.abort();await drain;
const last=await usage(), elapsed=performance.now()-started;
const cpuMs=(Number(last.CPUUsageNSec)-Number(first.CPUUsageNSec))/1e6;
console.log(JSON.stringify({elapsedMs:Math.round(elapsed),snapshotRequests:times.length,sseChunks:streams,streamBytes,httpP50Ms:percentile(times,.5),httpP95Ms:percentile(times,.95),sampleP50Ms:percentile(sampleMs,.5),sampleP95Ms:percentile(sampleMs,.95),maxPayloadBytes:Math.max(...payloadBytes),cpuMs,cpuPercentOfOneCore:100*cpuMs/elapsed,memoryBytes:Number(last.MemoryCurrent),restarts:Number(last.NRestarts)},null,2));
