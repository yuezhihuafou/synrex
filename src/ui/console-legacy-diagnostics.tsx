import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./console-app.css";
import { parseHar, type BrowserEvent } from "./browser-trace.js";
import { detectBrowserIncidents } from "./browser-incidents.js";
import { buildCausalGraph } from "./causal-graph.js";

type View = "overview" | "workflows" | "tasks" | "nodes" | "diagnostics" | "memory";
type Snapshot = {
  generatedAt: string;
  service: { status: string; release: string };
  nodes: Array<{ id: string; alias: string; kind: string; health: string; os: string; lastSeenAt: string;
    contract: { matching: number; missing: number; incompatible: number; total: number }; version: string | null }>;
  workflows: Array<{ id: string; title: string; goal: string; workspace: string; status: string; revision: number;
    phase: string; summary: string; nextSteps: string[]; blockers: string[]; taskIds: string[]; updatedAt: string }>;
  conversationSessions: Array<{id:string;title:string;lastAt:string;requestCount:number;runningTasks:number;state:string;requests:Array<{requestId:string;tool?:string;lastAt:string;taskId?:string;runId?:string;classification:string}>}>;
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string; status: string; lastUpdatedAt?: string }>;
  activeTaskUnits?: string[] | null;
  memory: { episodes: number; successful: number; notes: number; candidates: number; promoted: number };
  diagnostics: { count: number; observability?: { coverage: { observedEvents:number; observedRequests:number; tokenUsage:string; hostInference:string }; latency: { completed:number; medianMs:number|null; p95Ms:number|null; maximumMs:number|null }; lifecycle: { httpCompleted:number; closedEarly:number; handlerFailed:number; toolCompletedWithoutHttp:number; unknown:number }; transfer: { observedInputBytes:number; observedOutputBytes:number; approximateInputTokens:number|null; approximateOutputTokens:number|null }; capacity?: {inputP95:number|null;outputP95:number|null;largestOutput:number;largeResponses:number;bytesPerSecond:number|null} }; requests: Array<{ requestId: string; tool?: string; lastAt: string; taskId?: string; runId?: string;
    classification: string; status?: number }> };
};
const menus: Array<{ id: View; title: string; symbol: string; caption: string }> = [
  { id: "overview", title: "总览", symbol: "▦", caption: "系统状态" },
  { id: "workflows", title: "工作流", symbol: "☷", caption: "对话通过 Synrex 操作主机" },
  { id: "tasks", title: "执行索引", symbol: ">_", caption: "持久任务位置" },
  { id: "nodes", title: "主机节点", symbol: "⌘", caption: "版本与契约" },
  { id: "diagnostics", title: "诊断中心", symbol: "⌁", caption: "MCP 时间线" },
  { id: "memory", title: "记忆与治理", symbol: "◇", caption: "学习证据" },
];
const statusText: Record<string,string> = {
  online:"在线", offline:"离线", suspect:"连接异常", draining:"停止调度", active:"进行中",
  blocked:"阻塞", completed:"已完成", cancelled:"已取消",
  rev_http_completed:"Synrex 已返回", connection_closed_early:"连接提前断开",
  tool_finished_http_not_observed:"工具完成 / HTTP 未确认",
rev_handler_error:"执行错误", rev_incomplete_or_log_window_truncated:"状态未确认",
};
function time(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month:"2-digit", day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false }) : value;
}
function Badge({ value }: { value:string }) {
  const tone = ["online","completed","rev_http_completed"].includes(value) ? "ok"
    : ["offline","blocked","connection_closed_early","rev_handler_error"].includes(value) ? "bad" : "pending";
  return <span className={`badge badge-${tone}`}><i />{statusText[value] ?? value}</span>;
}
function Panel({ title, hint, extra, children }: { title:string; hint?:string; extra?:ReactNode; children:ReactNode }) {
  return <section className="panel"><div className="panel-header"><div><h3>{title}</h3>{hint && <p>{hint}</p>}</div>{extra}</div>{children}</section>;
}
function Metric({ label, value, info, symbol }: { label:string; value:string|number; info:string; symbol:string }) {
  return <div className="metric"><span className="metric-symbol">{symbol}</span><span className="metric-label">{label}</span>
    <strong>{value}</strong><small>{info}</small></div>;
}
function Blank({ children }: { children:ReactNode }) {
  return <div className="blank"><span>◌</span><p>{children}</p></div>;
}
async function getJson<T>(url:string, init?:RequestInit):Promise<T> {
  const r=await fetch(url,{ credentials:"same-origin",cache:"no-store",...init });
  if(!r.ok) throw new Error(r.status===401?"AUTH_REQUIRED":`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
export function LegacyDiagnostics({d,clockOffsetMs,clockUncertaintyMs}:{d:Snapshot;clockOffsetMs:number|null;clockUncertaintyMs:number|null}) {
  const [query,setQuery]=useState("");
  const [selectedRun,setSelectedRun]=useState<string|null>(null);
  const [runLog,setRunLog]=useState("");
  const [runLogOffset,setRunLogOffset]=useState(0);
  const [runLogSize,setRunLogSize]=useState(0);
  const [runLogError,setRunLogError]=useState("");
  async function loadRun(runId:string,offset=0){
    if(!/^run_\d{14}_[a-zA-Z0-9]{4,32}$/.test(runId))return;
    try{
      const result=await getJson<{text:string;nextOffset:number;size:number}>(`/console/api/run-log/${encodeURIComponent(runId)}?offset=${offset}`);
      setSelectedRun(runId);setRunLog(prev=>offset?prev+result.text:result.text);
      setRunLogOffset(result.nextOffset);setRunLogSize(result.size);setRunLogError("");
    }catch{setRunLogError("无法读取 Run Log；可能位于其他主机、已归档或已删除。");}
  }
  const [browser,setBrowser]=useState<BrowserEvent[]>([]);
  const [harError,setHarError]=useState("");
  const [autoCount,setAutoCount]=useState(0);
  const [lastExtensionSync,setLastExtensionSync]=useState<number|null>(null);
  const [incidents,setIncidents]=useState<Array<{id:string;at:string;trigger:BrowserEvent;events:BrowserEvent[]}>>([]);
  useEffect(()=>{
    try {
      const saved=JSON.parse(localStorage.getItem("synrex-browser-incidents-v1")||"[]");
      if(Array.isArray(saved))setIncidents(saved.slice(-30));
    } catch { /* Browser storage is optional. */ }
  },[]);
  useEffect(()=>{
    function onMessage(event:MessageEvent){
      if(event.source!==window || event.origin!==location.origin || event.data?.type!=="synrex-browser-trace-v1" || !Array.isArray(event.data.events))return;
      const safe=(event.data.events as BrowserEvent[]).slice(-1000).filter(x=>x && typeof x.at==="string" &&
        typeof x.host==="string" && typeof x.path==="string" && Number.isFinite(Date.parse(x.at)) &&
        (x.host==="chatgpt.com" || x.host==="chat.openai.com"));
      setBrowser(old=>{
        const merged=new Map(old.map(x=>[`${x.at}|${x.host}|${x.path}|${x.durationMs}`,x]));
        for(const x of safe)merged.set(`${x.at}|${x.host}|${x.path}|${x.durationMs}`,x);
        const next=[...merged.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-2000);
const discovered=detectBrowserIncidents(next);
        if(discovered.length)setIncidents(previous=>{
          const byId=new Map(previous.map(x=>[x.id,x]));
          let changed=false;
          for(const incident of discovered) {
            if(!byId.has(incident.id)){byId.set(incident.id,incident);changed=true;}
          }
          if(!changed)return previous;
          const recent=[...byId.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-30);
          try {localStorage.setItem("synrex-browser-incidents-v1",JSON.stringify(recent));} catch {}
          return recent;
        });
        return next;
      });
      setAutoCount(safe.length);
      setLastExtensionSync(Date.now());
      if(Array.isArray(event.data.incidents)) {
        setIncidents(event.data.incidents.slice(-30).filter((x:unknown):x is {id:string;at:string;trigger:BrowserEvent;events:BrowserEvent[]}=>{
          if(!x || typeof x!=="object")return false;
          const item=x as {id?:unknown;at?:unknown;trigger?:unknown;events?:unknown};
          return typeof item.id==="string"&&typeof item.at==="string"&&
            Boolean(item.trigger)&&Array.isArray(item.events);
        }));
      }
    }
    window.addEventListener("message",onMessage);return()=>window.removeEventListener("message",onMessage);
  },[]);
  const matched=useMemo(()=>d.diagnostics.requests.filter(r=>(r.requestId+" "+(r.tool??"")+" "+(r.taskId??""))
    .toLowerCase().includes(query.toLowerCase())),[d,query]);
  const graph=useMemo(()=>buildCausalGraph(d.diagnostics.requests,d.tasks,browser,clockOffsetMs??0),[d,browser,clockOffsetMs]);
  const connectedPaths=useMemo(()=>{
    const links=new Map<string,string[]>();
    for(const edge of graph.edges.filter(e=>e.confidence==="verified")){
      const targets=links.get(edge.from)??[];targets.push(edge.to);links.set(edge.from,targets);
    }
    return graph.nodes.filter(n=>n.kind==="mcp"&&links.has(n.id)).slice(-30).reverse().map(n=>{
      const task=links.get(n.id)?.find(id=>id.startsWith("task:"));
      const run=links.get(task??n.id)?.find(id=>id.startsWith("run:"))??
        links.get(n.id)?.find(id=>id.startsWith("run:"));
      return {mcp:n,task:task?graph.nodes.find(x=>x.id===task):undefined,run:run?graph.nodes.find(x=>x.id===run):undefined};
});
  },[graph]);
  const timeline=useMemo(()=>[
    ...matched.map(r=>({at:clockOffsetMs===null?r.lastAt:new Date(Date.parse(r.lastAt)+clockOffsetMs).toISOString(),source:"MCP",detail:`${r.tool??"请求"} · ${r.requestId}`,state:r.classification})),
    ...browser.filter(r=>(r.host+" "+r.path+" "+(r.requestId??"")).toLowerCase().includes(query.toLowerCase()))
      .map(r=>({at:r.at,source:"浏览器",detail:`${r.method} ${r.host}${r.path} · ${Math.round(r.durationMs)}ms`,state:r.error || String(r.status || "未完成")})),
  ].sort((a,b)=>a.at.localeCompare(b.at)).slice(-500),[matched,browser,query,clockOffsetMs]);
  async function importHar(file?:File) {
    if (!file) return;
    setHarError("");
    if(file.size>15_000_000){setHarError("HAR 超过 15 MB 限制");return;}
    try {setBrowser(parseHar(JSON.parse(await file.text())));}catch(e){setHarError(e instanceof Error?e.message:"无效的 HAR 文件");}
  }
  function exportIncident(incident:{id:string;at:string;trigger:BrowserEvent;events:BrowserEvent[]}) {
    const payload={schema:"synrex-incident-v1",capturedAt:new Date().toISOString(),
      browser:incident,serverClockOffsetMs:clockOffsetMs,serverClockUncertaintyMs:clockUncertaintyMs,
      mcp:d.diagnostics.requests.filter(r=>Math.abs(Date.parse(r.lastAt)-Date.parse(incident.at))<120000)};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const anchor=document.createElement("a");anchor.href=url;anchor.download="synrex-incident-"+incident.id+".json";
    anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="stack"><div className="notice"><strong>把卡顿定位到正确层级</strong>
    <p>工具执行结束且 HTTP 200，说明 Synrex 已返回；它无法证明 ChatGPT 模型或界面已经继续。</p></div>
    {d.diagnostics.observability && <Panel title="请求延迟、生命周期与 Token 可观测性" hint="仅统计本机保留的诊断事件；不是 ChatGPT 端到端耗时">
      <div className="metrics">
        <Metric label="MCP 中位 / p95" value={`${d.diagnostics.observability.latency.medianMs ?? "—"} / ${d.diagnostics.observability.latency.p95Ms ?? "—"} ms`} info={`${d.diagnostics.observability.latency.completed} 个有耗时的完成请求`} symbol="◷"/>
        <Metric label="HTTP 完成 / 提前断开" value={`${d.diagnostics.observability.lifecycle.httpCompleted} / ${d.diagnostics.observability.lifecycle.closedEarly}`} info="只表示 Synrex 侧观测" symbol="⌁"/>
        <Metric label="未确认 / 执行错误" value={`${d.diagnostics.observability.lifecycle.unknown + d.diagnostics.observability.lifecycle.toolCompletedWithoutHttp} / ${d.diagnostics.observability.lifecycle.handlerFailed}`} info="滚动日志截断可能造成未知状态" symbol="?"/>
        <Metric label="MCP 输出 p95" value={`${d.diagnostics.observability.capacity?.outputP95?.toLocaleString()??"—"} B`} info="已完成请求的输出体积；不是 GPT Token" symbol="⇥"/>
      </div>
      <p className="footnote">已观测 MCP 输入 {d.diagnostics.observability.transfer.observedInputBytes.toLocaleString()} B、输出 {d.diagnostics.observability.transfer.observedOutputBytes.toLocaleString()} B；覆盖 {d.diagnostics.observability.coverage.observedRequests} 个请求。仅有 HTTP 完成证据时，模型推理中断与 ChatGPT 消息断流仍不可区分，需结合浏览器 HAR。</p>
      <p className="footnote">输入 p95：{d.diagnostics.observability.capacity?.inputP95?.toLocaleString()??"—"} B；最大输出：{d.diagnostics.observability.capacity?.largestOutput.toLocaleString()??"—"} B；超过 16 KiB 的响应：{d.diagnostics.observability.capacity?.largeResponses??"—"}；平均有效输出吞吐估计：{d.diagnostics.observability.capacity?.bytesPerSecond?.toLocaleString()??"—"} B/s（用整段 MCP 耗时估算，包含执行等待，不代表模型生成速度）。</p>
    </Panel>}
    <Panel title="浏览器网络证据" hint="本地读取 HAR，仅保留请求时间、域名、路径、状态和耗时；不会上传原始 HAR">
      <p><a href="/console/browser-extension.zip">下载 Synrex Browser Trace 扩展</a> · 首次安装后按版本更新；扩展仅读取 ChatGPT 网络元数据</p>
      <label>导入浏览器 DevTools 导出的 HAR（建议先过滤 ChatGPT 请求） <input type="file" accept=".har,.json,application/json" onChange={e=>void importHar(e.target.files?.[0])}/></label>
      <p className="footnote">扩展链路：{lastExtensionSync===null?"尚未收到消息":`最近同步于 ${new Date(lastExtensionSync).toLocaleTimeString()}`}；已读取 {browser.length} 条浏览器请求；最近一次同步 {autoCount} 条。{clockOffsetMs===null?"尚未校准浏览器与 swy1 时钟":`估计浏览器相对 swy1 时钟偏移 ${Math.round(clockOffsetMs)} ms，采样网络不确定度约 ±${Math.round(clockUncertaintyMs??0)} ms`}。仅有共同请求 ID 才是确定关联；时间接近只是线索。</p>
      {harError&&<p role="alert">{harError}</p>}
      {!!browser.length&&<button onClick={()=>setBrowser([])}>清除浏览器数据</button>}
</Panel>
    <Panel title="自动故障快照" hint="扩展保留最近 2 分钟元数据；429、5xx、网络失败或超过 30 秒时自动冻结最多 30 份证据">
      {incidents.slice().reverse().slice(0,12).map(i=><div className="list-row" key={i.id}>
        <div className="grow"><strong>{i.trigger.status||i.trigger.error} · {i.trigger.path}</strong>
          <small>{new Date(i.at).toLocaleString()} · {i.events.length} 条浏览器上下文请求</small>
          <small>附近 MCP 事件：{d.diagnostics.requests.filter(r=>Math.abs(Date.parse(r.lastAt)-Date.parse(i.at))<120000).length} 条（仅时间候选，非确定关联）</small></div>
        <button onClick={()=>exportIncident(i)}>导出证据</button>
      </div>)}
      {!incidents.length&&<Blank>尚无自动冻结的故障证据；需启用 Synrex Browser Trace 扩展</Blank>}
      <p className="footnote">按需深度抓包：在 Chrome 打开 chrome://net-export，选择默认隐私保护模式开始记录，复现后停止；原始 NetLog 不会上传至 Synrex。扩展无法获取 ChatGPT 内部模型事件或完整流式消息帧。</p>
    </Panel>
    <Panel title="端到端时间线（已知事件）" hint="按请求 ID、工具、域名或路径过滤；浏览器时间必须校准">
      <input className="filter" placeholder="会话 / 请求 / 域名筛选" value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>来源</th><th>事件</th><th>状态</th></tr></thead><tbody>
        {timeline.map((r,i)=><tr key={`${r.source}-${r.at}-${i}`}><td>{new Date(r.at).toLocaleString()}</td><td>{r.source}</td><td>{r.detail}</td><td>{r.state}</td></tr>)}
      </tbody></table></div>
    </Panel>
    <Panel title="跨层因果关联图" hint="实线语义：共享 Task/Run ID；时间候选不构成因果证明">
      <p>节点 {graph.nodes.length} · 确定关联 {graph.edges.filter(e=>e.confidence==="verified").length} · 时间候选 {graph.edges.filter(e=>e.confidence==="temporal").length}</p>
      <div className="stack">
        {connectedPaths.map(path=><div className="list-row" key={path.mcp.id} style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:10}}>
          <div className="checkpoint-block"><small>MCP</small><strong>{path.mcp.label}</strong><small>{path.mcp.status}</small></div>
          <span aria-hidden="true">→</span>
          {path.task?<div className="checkpoint-block"><small>Task · ID 确认</small><strong>{path.task.label}</strong><small>{path.task.status}</small></div>:<small>无持久子任务</small>}
          {path.run&&<><span aria-hidden="true">→</span><div className="checkpoint-block">
            <small>Run Log · ID 确认</small><button onClick={()=>void loadRun(path.run!.label)}>{path.run.label}</button></div></>}
        </div>)}
        {!connectedPaths.length&&<Blank>目前的诊断窗口没有带可确认 Task/Run ID 的调用链；下方仍保留浏览器时间候选。</Blank>}
      </div>
      <div className="table-scroll"><table><thead><tr><th>源事件</th><th>关系</th><th>目标事件</th><th>证据</th></tr></thead><tbody>
        {graph.edges.slice(-150).reverse().map((edge,i)=><tr key={edge.from+edge.to+i}>
          <td><code>{edge.from}</code></td><td>{edge.relation}</td><td>{edge.to.startsWith("run:")?<button onClick={()=>void loadRun(edge.to.slice(4))}>{edge.to}</button>:<code>{edge.to}</code>}</td>
          <td>{edge.confidence==="verified"?"ID 确认":"仅时间接近"}</td></tr>)}
      </tbody></table></div>
      {selectedRun&&<div className="checkpoint"><strong>Run Log · {selectedRun}</strong>
        <p>{runLogOffset.toLocaleString()} / {runLogSize.toLocaleString()} 字节</p>
        <pre style={{maxHeight:320,overflow:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{runLog}</pre>
        {runLogOffset<runLogSize&&<button onClick={()=>void loadRun(selectedRun,runLogOffset)}>读取下一段（16 KB）</button>}
      </div>}
      {runLogError&&<p role="alert">{runLogError}</p>}
      <p className="footnote">只读按需分页加载 Run Log，每页最多 16 KB。跨主机任务日志需在所属执行节点查询；时间相关不是已证明的父子调用。</p>
    </Panel>
    <Panel title="MCP 请求时间线" hint="最小可用诊断 · 约 2 MB 滚动容量"
      extra={<input className="filter" placeholder="按请求或工具筛选" value={query} onChange={e=>setQuery(e.target.value)}/>}>
      {matched.map(r=><div className="list-row" key={r.requestId}><span className="round-symbol">⌁</span>
        <div className="grow"><strong>{r.tool??"MCP 请求"}</strong><small>{r.requestId}</small>
          {r.taskId&&<small>Task: {r.taskId}</small>}</div><Badge value={r.classification}/><time>{time(r.lastAt)}</time></div>)}
      {!matched.length&&<Blank>没有匹配的请求记录</Blank>}
    </Panel></div>;
}
