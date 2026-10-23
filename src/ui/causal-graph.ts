import type { BrowserEvent } from "./browser-trace.js";

export type GraphNode={id:string;kind:"browser"|"mcp"|"task"|"run";label:string;at:string;status:string};
export type GraphEdge={from:string;to:string;relation:string;confidence:"verified"|"temporal"};
export type GraphRequest={requestId:string;conversationId?:string;tool?:string;lastAt:string;taskId?:string;runId?:string;classification:string};
export type GraphTask={id:string;runId:string|null;status:string;createdAt:string};
export function buildCausalGraph(requests:GraphRequest[],tasks:GraphTask[],browser:BrowserEvent[],offsetMs=0){
  const nodes:GraphNode[]=[];const edges:GraphEdge[]=[];const seen=new Set<string>();
  const put=(n:GraphNode)=>{if(!seen.has(n.id)){seen.add(n.id);nodes.push(n);}};
  const taskById=new Map(tasks.map(t=>[t.id,t]));
  for(const r of requests.slice(-500)){
    const m="mcp:"+r.requestId;
    put({id:m,kind:"mcp",label:(r.tool??"MCP")+" · "+r.requestId,at:r.lastAt,status:r.classification});
    const task=r.taskId?taskById.get(r.taskId):undefined;
    if(r.taskId){
      const t="task:"+r.taskId;put({id:t,kind:"task",label:r.taskId,at:task?.createdAt??r.lastAt,status:task?.status??"unknown"});
      edges.push({from:m,to:t,relation:"taskId",confidence:"verified"});
    }
    const runId=r.runId??task?.runId;
    if(runId && /^run_[a-zA-Z0-9_-]+$/.test(runId)){
      const run="run:"+runId;put({id:run,kind:"run",label:runId,at:r.lastAt,status:"log reference"});
      edges.push({from:r.taskId?"task:"+r.taskId:m,to:run,relation:"runId",confidence:"verified"});
    }
  }
  for(const [index,b] of browser.slice(-500).entries()){
    const key="browser:"+index+":"+b.at;
    put({id:key,kind:"browser",label:b.method+" "+b.path,at:b.at,status:b.error||String(b.status)});
    const started=Date.parse(b.at)-offsetMs;
    if(!Number.isFinite(started))continue;
    // Browser and Synrex generally do not share trace identifiers.
    // A temporal candidate must never be rendered as a confirmed causal edge.
    const close=requests.filter(r=>Math.abs(Date.parse(r.lastAt)-started)<=3000).slice(0,4);
    for(const r of close)edges.push({from:key,to:"mcp:"+r.requestId,relation:"time ±3s",confidence:"temporal"});
  }
  return {nodes,edges};
}
