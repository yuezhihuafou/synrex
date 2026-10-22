// Ephemeral client-side diagnostic scoring. Never claim a browser request is
// the exact Synrex tool request without a host-provided shared identifier.
export type BrowserDiagnostic = {
  kind:string; reason:string;ts:number;tabId?:number;flowId?:string;
  endpointGroup?:string;requestType?:string;durationMs?:number;
  status?:number;errorCategory?:string;conversationTitle?:string;
};
export type BrowserFinding = {
  at:number;kind:"browser_network_error"|"unpaired_ui_timeout"|"ambiguous_transport_timeout";
  severity:"warning"|"unknown";description:string;candidateFlows:number;
};
export function analyzeBrowserTransport(events:BrowserDiagnostic[]):BrowserFinding[]{
  const byFlow=new Map<string,BrowserDiagnostic[]>();
  for(const e of events){
    if(e.kind!=="network" || !e.flowId)continue;
    const list=byFlow.get(e.flowId)??[];list.push(e);byFlow.set(e.flowId,list);
  }
  const findings:BrowserFinding[]=[];
  for(const e of events){
    if(e.kind!=="ui" || e.reason!=="transport_timeout")continue;
    const candidates=[...byFlow.values()].filter(flow=>{
      if(flow[0]?.tabId!==e.tabId)return false;
      const first=Math.min(...flow.map(x=>x.ts));
      const last=Math.max(...flow.map(x=>x.ts));
      return first<=e.ts+15000 && last>=e.ts-120000 &&
        flow.some(x=>x.endpointGroup==="conversation"||x.requestType==="xmlhttprequest");
    });
    const failed=candidates.filter(flow=>flow.some(x=>x.reason==="network_error" &&
      x.ts >= e.ts-120000 && x.ts<=e.ts+15000));
    if(failed.length) {
      findings.push({at:e.ts,kind:"browser_network_error",severity:"warning",
        description:"同标签页附近存在浏览器报告的网络错误；尚不能确认与本条对话属于同一请求。",
        candidateFlows:failed.length});
    }else if(!candidates.length){
      findings.push({at:e.ts,kind:"unpaired_ui_timeout",severity:"unknown",
        description:"页面报告消息超时，但附近没有可关联的会话网络记录；可能是扩展覆盖缺失、宿主内部消息流或时序问题。",
        candidateFlows:0});
    }else{
      findings.push({at:e.ts,kind:"ambiguous_transport_timeout",severity:"unknown",
        description:"页面消息超时附近存在会话请求，但没有可关联的网络失败；无法区分平台消息流、浏览器完成确认与代理链路。",
        candidateFlows:candidates.length});
    }
  }
  return findings.slice(-50);
}
