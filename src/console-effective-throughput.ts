/** Pure aggregation. A host session marker is correlation evidence, NOT proof of GPT identity. */
export interface EffectiveCall {
  requestId: string;
  conversationId?: string;
  startMs: number;
  endMs: number;
  outputTokens: number;
}

export function unionMilliseconds(intervals: ReadonlyArray<{startMs:number;endMs:number}>):number {
  const ordered=intervals.filter(x=>Number.isFinite(x.startMs)&&Number.isFinite(x.endMs)&&x.endMs>x.startMs)
    .sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
  let total=0,start=0,end=0,opened=false;
  for(const item of ordered){
    if(!opened){start=item.startMs;end=item.endMs;opened=true;continue;}
    if(item.startMs>end){total+=end-start;start=item.startMs;end=item.endMs;}
    else end=Math.max(end,item.endMs);
  }
  return total+(opened?end-start:0);
}

const rate=(tokens:number,ms:number)=>ms>0?Math.round(tokens*10000/ms)/10:null;

/** Last-24h summary only; never merge intervals from distinct conversations. */
export function summarizeEffectiveThroughput(calls:readonly EffectiveCall[],now:number) {
  const earliest=now-86400000;
  const eligible=calls.filter(c=>c.endMs<=now&&c.endMs>earliest&&c.startMs<=c.endMs
    &&Number.isFinite(c.outputTokens)&&c.outputTokens>=0);
  const host=eligible.filter(c=>c.conversationId?.startsWith("conv_"));
  const unknown=eligible.length-host.length;
  const perConversation=new Map<string,EffectiveCall[]>();
  for(const call of host){const items=perConversation.get(call.conversationId!)??[];items.push(call);perConversation.set(call.conversationId!,items);}
  let perSessionActiveMs=0;
  const sessions=[...perConversation.entries()].map(([conversationId,items])=>{
    const activeMs=unionMilliseconds(items);
    const outputTokens=items.reduce((sum,c)=>sum+c.outputTokens,0);
    const startMs=Math.min(...items.map(c=>c.startMs));
    const endMs=Math.max(...items.map(c=>c.endMs));
    return {conversationId,matchedCalls:items.length,outputTokens,activeMs,
      observedSpanMs:endMs-startMs,activeTokensPerSecond:rate(outputTokens,activeMs),
      firstAt:new Date(startMs).toISOString(),lastAt:new Date(endMs).toISOString()};
  }).sort((a,b)=>b.lastAt.localeCompare(a.lastAt));
  for(const session of sessions)perSessionActiveMs+=session.activeMs;
  const hostTokens=host.reduce((s,c)=>s+c.outputTokens,0);
  const globalActiveMs=unionMilliseconds(host);
  const events=host.flatMap(c=>[{at:c.startMs,delta:1},{at:c.endMs,delta:-1}])
    .sort((a,b)=>a.at-b.at||a.delta-b.delta);
  let active=0,maxConcurrency=0;
  for(const e of events){active+=e.delta;maxConcurrency=Math.max(maxConcurrency,active);}
  return {
    windowSeconds:86400, scope:"host_session_associated" as const,
    outputTokens:hostTokens, matchedCalls:host.length, unknownCalls:unknown,
    sessions,
    totalMatchedCalls:eligible.length, sessionCount:perConversation.size,
    perSessionActiveMs,globalActiveMs,maxConcurrency,
    perSessionTokensPerSecond:rate(hostTokens,perSessionActiveMs),
    globalActiveTokensPerSecond:rate(hostTokens,globalActiveMs),
    attributionCoveragePercent:eligible.length?Math.round(host.length/eligible.length*1000)/10:null,
    status:host.length?"observed" as const:"unavailable" as const,
    note:"Host conversation metadata is correlation evidence, not independently verified GPT identity. Subagent provider usage is maintained separately; unattributed calls are excluded.",
  };
}
