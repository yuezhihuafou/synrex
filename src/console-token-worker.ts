import { parentPort } from "node:worker_threads";
// Plain Worker ESM does not use tsx's .js -> .ts import remapping in source tests.
const meter=await import(new URL("./console-token-meter"+(import.meta.url.endsWith(".ts")?".ts":".js"),
  import.meta.url).href);

// Ephemeral content stays in this process's memory and is never logged or saved.
parentPort?.on("message",(job: {id:number;kind:"input"|"output";body:string;mode?:"json"|"sse"|"unknown"})=>{
  const value=job.kind==="input"?meter.countSerializedToolTokens(job.body)
    :meter.countToolOutputTokens(job.body,job.mode??"unknown");
  parentPort?.postMessage({id:job.id,tokens:value});
});
