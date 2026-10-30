import { Worker } from "node:worker_threads";
import { MAX_TOOL_METER_BYTES } from "./console-token-policy.js";

type Kind="input"|"output";
type Job={kind:Kind;body:string;mode?:"json"|"sse"|"unknown"};
type Callback=(tokens:number)=>void;
const MAX_INFLIGHT=16;
let worker:Worker|undefined;
let nextId=0;
const waiting=new Map<number,Callback>();

function start():Worker|null {
  if(worker)return worker;
  try {
    const sourceMode=import.meta.url.endsWith(".ts");
    const started=new Worker(new URL(sourceMode?"./console-token-worker.ts":"./console-token-worker.js",import.meta.url),
      sourceMode?{execArgv:["--import","tsx"]}:{execArgv:[]});
    started.on("message",(message:{id:number;tokens:number|null})=>{
      const onCount=waiting.get(message.id);
      waiting.delete(message.id);
      if(onCount && typeof message.tokens==="number" && Number.isSafeInteger(message.tokens)) {
        try{onCount(message.tokens);}catch{/* Monitoring must never affect tool calls. */}
      }
    });
    const stop=()=>{if(worker===started)worker=undefined;waiting.clear();};
    started.on("error",stop);started.on("exit",stop);
    started.unref();
    worker=started;
    return started;
  } catch {return null;}
}

/** Best-effort, bounded, non-blocking metering; silently drop on overload. */
export function measureToolTokens(job:Job, callback:Callback):boolean {
  if(process.env.SYNREX_TOKEN_METER_DISABLED==="1")return false;
  if(waiting.size>=MAX_INFLIGHT || Buffer.byteLength(job.body,"utf8")>MAX_TOOL_METER_BYTES)return false;
  const thread=start();
  if(!thread)return false;
  const id=++nextId;
  waiting.set(id,callback);
  try {thread.postMessage({id,...job});return true;}
  catch {waiting.delete(id);return false;}
}
