import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./console-app.css";

type View = "overview" | "workflows" | "tasks" | "nodes" | "diagnostics" | "resources" | "memory";
type ObservedSpan = {ts:string;traceId:string;spanId:string;parentSpanId?:string;
  name:string;durationMs:number;status:string;requestId?:string};
type BrowserEvent = {ts:number;kind:"network"|"ui"|"conversation_title";reason:string;tabId?:number;
  requestType?:string;durationMs?:number;status?:number;startedAt?:string;host?:string;conversationTitle?:string};
type Snapshot = {
  generatedAt: string;
  service: { status: string; release: string };
  nodes: Array<{ id: string; alias: string; kind: string; health: string; os: string; lastSeenAt: string;
    contract: { matching: number; missing: number; incompatible: number; total: number }; version: string | null }>;
  workflows: Array<{ id: string; title: string; goal: string; workspace: string; status: string; revision: number;
    phase: string; summary: string; nextSteps: string[]; blockers: string[]; taskIds: string[]; updatedAt: string }>;
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string }>;
  memory: { episodes: number; successful: number; candidates: number; promoted: number };
  diagnostics: { count: number; requests: Array<{ requestId: string; tool?: string; lastAt: string; taskId?: string;
    conversationTitle?:string; conversationId?:string;
    classification: string; status?: number }>; events: Array<{ ts:string; event:string; requestId?:string;
    traceId?:string; nodeRequestId?:string; callId?:string; taskId?:string; nodeId?:string;
    conversationTitle?:string; conversationId?:string;
    stage?:string; durationMs?:number; elapsedMs?:number; status?:number; outcome?:string; tool?:string;
    rssBytes?:number; heapUsedBytes?:number; cpuUserMicros?:number; cpuSystemMicros?:number; eventLoopLagMs?:number; bootId?:string;
    eventLoopP95Ms?:number; eventLoopUtilizationPermille?:number; gcDurationMs?:number; gcCount?:number;
    activeToolCount?:number; tcpConnections?:number; tcpRttP50Ms?:number; tcpRttP95Ms?:number;
    tcpRetransSockets?:number; tcpRetransSegmentsTotal?:number; tunnelUnit?:string }> };
  observability: { collector:"bounded_tail"|"not_collected"; peerSync: {
    gateway:"current"|"stale"|"unavailable"; at?:string }; runtime: {
    rssBytes?:number; heapUsedBytes?:number; eventLoopLagMs?:number;
    eventLoopP95Ms?:number; eventLoopUtilizationPermille?:number;
    gcDurationMs?:number; gcCount?:number; activeToolCount?:number;
    otelSpanPending?:number; otelSpanDropped?:number;
    cpuUserMicros?:number; cpuSystemMicros?:number; at?:string };
    network: { tcpConnections?:number; tcpRttP50Ms?:number; tcpRttP95Ms?:number;
      tcpRetransSockets?:number; tcpRetransSegmentsTotal?:number; at?:string };
    collectorHealth: { refusedLogs?:number; refusedMetrics?:number; exporterFailed?:number; at?:string };
    metrics: Array<{ts:string;name:string;value:number;nodeId?:string;processPid?:number;processName?:string}> };
};
const menus: Array<{ id: View; title: string; symbol: string; caption: string }> = [
  { id: "overview", title: "总览", symbol: "▦", caption: "系统状态" },
  { id: "workflows", title: "工作流", symbol: "☷", caption: "任务与检查点" },
  { id: "tasks", title: "执行索引", symbol: ">_", caption: "持久任务位置" },
  { id: "nodes", title: "主机节点", symbol: "⌘", caption: "版本与契约" },
  { id: "diagnostics", title: "诊断中心", symbol: "⌁", caption: "MCP 时间线" },
  { id: "resources", title: "资源与网络", symbol: "▥", caption: "进程 / CPU / 网络" },
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
function Login({ done }: { done:()=>void }) {
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function onSubmit(e:FormEvent) {
    e.preventDefault(); setBusy(true);setError("");
    try {
      await getJson("/console/api/login",{ method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password}) });
      setPassword("");done();
    } catch {setError("验证失败。请确认 Owner 密码，或稍后重试。");}
    finally {setBusy(false);}
  }
  return <main className="login-bg"><div className="login-panel">
    <span className="brand-mark">S</span><p className="eyebrow">SYNREX / OPERATIONS</p>
    <h1>你的开发环境，<br/>一目了然。</h1>
    <p className="login-subtitle">统一查看工作流、主机、持久任务和诊断证据。普通 GPT 对话仍是主要编程入口。</p>
    <form onSubmit={onSubmit}><label htmlFor="owner-pass">Owner 密码</label>
      <input id="owner-pass" autoComplete="current-password" type="password" required value={password}
        onChange={e=>setPassword(e.target.value)} placeholder="请输入 Synrex Owner 密码"/>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy||!password}>{busy?"验证中…":"进入控制台 →"}</button>
    </form><footer>私有访问 · 独立会话 · 只读管理</footer>
  </div></main>;
}
function Overview({ d, go }: {d:Snapshot;go:(v:View)=>void}) {
  const online=d.nodes.filter(x=>x.health==="online").length;
  const active=d.workflows.filter(x=>x.status==="active").length;
  return <div className="stack">
    <div className="metrics">
      <Metric label="在线节点" value={`${online} / ${d.nodes.length}`} info="计算网络" symbol="⌘"/>
      <Metric label="进行中工作流" value={active} info="持久检查点" symbol="☷"/>
      <Metric label="任务索引" value={d.tasks.length} info="最近 30 项" symbol=">_"/>
      <Metric label="待确认请求" value={d.diagnostics.requests.filter(x=>x.classification!=="rev_http_completed").length}
        info="诊断时间线" symbol="⌁"/>
    </div>
    <div className="columns">
      <Panel title="执行节点" hint="主机运行状态" extra={<button className="link" onClick={()=>go("nodes")}>查看全部 →</button>}>
        {d.nodes.map(n=><div className="list-row" key={n.id}><span className="round-symbol">⌘</span>
          <div className="grow"><strong>{n.alias}</strong><small>{n.kind==="local"?"主服务":"远程主机"} · {n.os}</small></div><Badge value={n.health}/></div>)}
        {!d.nodes.length&&<Blank>暂无登记节点</Blank>}
      </Panel>
      <Panel title="近期工作流" hint="保存的进度与恢复入口" extra={<button className="link" onClick={()=>go("workflows")}>查看全部 →</button>}>
        {d.workflows.slice(0,4).map(w=><div className="list-row" key={w.id}><span className="round-symbol">☷</span>
          <div className="grow"><strong>{w.title}</strong><small>{w.workspace} · {time(w.updatedAt)}</small></div><Badge value={w.status}/></div>)}
        {!d.workflows.length&&<Blank>暂无保存的工作流</Blank>}
      </Panel>
    </div>
    <Panel title="近期请求" hint="MCP 执行和网络连接的最后已知状态" extra={<button className="link" onClick={()=>go("diagnostics")}>诊断中心 →</button>}>
      {d.diagnostics.requests.slice(0,7).map(r=><div className="list-row" key={r.requestId}>
        <span className="round-symbol">⌁</span><div className="grow"><strong>{r.tool||"MCP 请求"}</strong><small>{r.requestId}</small></div>
        <Badge value={r.classification}/><time>{time(r.lastAt)}</time></div>)}
      {!d.diagnostics.requests.length&&<Blank>还没有最近的请求记录</Blank>}
    </Panel>
  </div>;
}
function Workflows({d}:{d:Snapshot}) {
  const [id,setId]=useState<string|null>(null);
  const current=d.workflows.find(x=>x.id===id)??d.workflows[0];
  return <div className="columns workflows-columns">
    <Panel title="工作流" hint="本地 SQLite 持久化">
      {d.workflows.map(w=><button className={`pick ${current?.id===w.id?"picked":""}`} key={w.id} onClick={()=>setId(w.id)}>
        <div className="grow"><strong>{w.title}</strong><small>{w.workspace} · Revision {w.revision}</small></div>
        <Badge value={w.status}/></button>)}
      {!d.workflows.length&&<Blank>暂无工作流</Blank>}
    </Panel>
    <Panel title="检查点" hint="只读 · 通过 GPT 对话继续执行">
      {current?<div className="checkpoint"><Badge value={current.status}/><h2>{current.title}</h2>
        <p>{current.goal}</p><code className="id-block">{current.id}</code>
        <div className="checkpoint-block"><small>当前阶段</small><strong>{current.phase||"—"}</strong><p>{current.summary}</p></div>
        <div className="checkpoint-block"><small>下一步</small>{current.nextSteps.length
          ?<ol>{current.nextSteps.map((x,i)=><li key={i}>{x}</li>)}</ol>:<p>没有剩余步骤</p>}</div>
        {current.blockers.length>0&&<div className="checkpoint-block"><small>阻塞事项</small><ul>{current.blockers.map((x,i)=><li key={i}>{x}</li>)}</ul></div>}
        <p className="footnote">复制工作流 ID，在普通 GPT 对话中要求继续该任务即可。</p>
      </div>:<Blank>选择一个工作流查看</Blank>}
    </Panel>
  </div>;
}
function Tasks({d}:{d:Snapshot}) {
  const names=new Map(d.nodes.map(x=>[x.id,x.alias]));
  return <Panel title="持久任务索引" hint="只显示已登记的执行位置；不能把任务索引误认为实际运行状态">
    <div className="table-scroll"><table><thead><tr><th>任务 ID</th><th>执行节点</th><th>Run ID</th><th>创建时间</th></tr></thead>
    <tbody>{d.tasks.map(t=><tr key={t.id}><td><code title={t.id}>{t.id.slice(0,23)}…</code></td>
      <td>{names.get(t.nodeId)??t.nodeId}</td><td><code>{t.runId??"—"}</code></td><td>{time(t.createdAt)}</td></tr>)}</tbody></table></div>
    {!d.tasks.length&&<Blank>暂无任务索引</Blank>}
    <p className="footnote">持久任务的实时进程状态与完整输出保存在执行节点上。当前页面不推断任务已完成。</p>
  </Panel>;
}
function Nodes({d}:{d:Snapshot}) {
  return <div className="node-grid">{d.nodes.map(n=><article key={n.id} className="node-card">
    <div className="node-top"><span className="round-symbol large">⌘</span><Badge value={n.health}/></div>
    <h3>{n.alias}</h3><p>{n.kind==="local"?"主服务 / 开发":"远程执行节点"} · {n.os}</p>
    <dl><div><dt>最近心跳</dt><dd>{time(n.lastSeenAt)}</dd></div>
      <div><dt>运行版本</dt><dd>{n.version??"未知"}</dd></div>
      <div><dt>能力契约</dt><dd>{n.contract.matching}/{n.contract.total}</dd></div></dl>
    {n.contract.missing>0&&<p className="warning">{n.contract.missing} 个本地工具契约未在此节点声明；远程调用仍须逐项校验。</p>}
    <code>{n.id}</code></article>)}</div>;
}
function Diagnostics({d}:{d:Snapshot}) {
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<{events:Snapshot["diagnostics"]["events"];spans:ObservedSpan[];
    conversationTitle?:string|null;titleSource?:string;
    truncated:boolean;archiveCoverage:string;remoteState?:string}|null>(null);
  const [titleDraft,setTitleDraft]=useState("");
  const [labelMessage,setLabelMessage]=useState("");
  const [history,setHistory]=useState<Snapshot["diagnostics"]["events"]>([]);
  const [filter,setFilter]=useState("");
  const [historyStart,setHistoryStart]=useState("");
  const [historyEnd,setHistoryEnd]=useState("");
  const [historyStats,setHistoryStats]=useState<{events:number;spans:number;metrics:number;first?:string;last?:string}|null>(null);
  const [historyPeer,setHistoryPeer]=useState("unknown");
  const [browserEvents,setBrowserEvents]=useState<BrowserEvent[]>([]);
  const [browserError,setBrowserError]=useState("");
  const matched=useMemo(()=>d.diagnostics.requests.filter(r=>(r.requestId+" "+(r.tool??"")+" "+(r.taskId??"")+" "+(r.conversationTitle??""))
    .toLowerCase().includes(query.toLowerCase())),[d,query]);
  const chosen=selected??matched[0]?.requestId;
  useEffect(()=>{
    let cancelled=false;
    setDetail(null);
    if(chosen)void getJson<{events:Snapshot["diagnostics"]["events"];spans:ObservedSpan[];
      conversationTitle?:string|null;titleSource?:string;truncated:boolean;archiveCoverage:string}>(
      "/console/api/trace?requestId="+encodeURIComponent(chosen)).then(result=>{
        if(!cancelled){setDetail(result);setTitleDraft(result.conversationTitle??"");}
      }).catch(()=>{if(!cancelled)setDetail(null);});
    return()=>{cancelled=true;};
  },[chosen]);
  const trace=(detail?.events??d.diagnostics.events.filter(e=>chosen && [e.requestId,e.traceId,e.nodeRequestId].includes(chosen)))
    .slice().reverse();
  async function labelSelected(){
    if(!chosen || !titleDraft.trim())return;
    setLabelMessage("");
    try{
      const result=await getJson<{label:{conversationTitle:string}}>("/console/api/conversation-label",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({requestId:chosen,conversationTitle:titleDraft.trim()}),
      });
      setDetail(prev=>prev?{...prev,conversationTitle:result.label.conversationTitle,titleSource:"owner"}:prev);
      setLabelMessage("已登记：手动关联该请求。");
    }catch{setLabelMessage("标题登记失败，请确认请求仍在归档中。");}
  }
  const spans=detail?.spans??[];
  const origin=spans.length ? Math.min(...spans.map(s=>Date.parse(s.ts))) : 0;
  const endpoint=spans.length ? Math.max(...spans.map(s=>Date.parse(s.ts)+s.durationMs)) : 0;
  const total=Math.max(1,endpoint-origin);
  const relatedBrowser=browserEvents.filter(e=>{
    if(!trace.length)return false;
    const times=trace.map(x=>Date.parse(x.ts)).filter(Number.isFinite);
    if(!times.length)return false;
    return e.ts>=Math.min(...times)-120000&&e.ts<=Math.max(...times)+120000;
  }).slice(-100);
  async function loadHistory(){
    const params=new URLSearchParams();
    if(filter)params.set("event",filter);
    if(historyStart)params.set("start",new Date(historyStart).toISOString());
    if(historyEnd)params.set("end",new Date(historyEnd).toISOString());
    const payload=await getJson<{events:Snapshot["diagnostics"]["events"];stats:{events:number;spans:number;metrics:number;first?:string;last?:string};gatewayHistory:string}>(
      "/console/api/history?"+params);
    setHistory(payload.events);
    setHistoryStats(payload.stats);setHistoryPeer(payload.gatewayHistory);
  }
  async function loadBrowserMetadata(file:File){
    setBrowserError("");
    if(file.size>1024*1024){setBrowserError("文件超过 1 MiB 上限");return;}
    try{
      const data=JSON.parse(await file.text()) as {schema?:string;events?:BrowserEvent[]};
      if(data.schema!=="synrex.browser.v1"||!Array.isArray(data.events))throw Error("Invalid schema");
      const accepted=data.events.filter(e=>e && (e.kind==="network"||e.kind==="ui"||e.kind==="conversation_title") &&
        typeof e.ts==="number"&&Number.isFinite(e.ts)&&
        ["completed","network_error","transport_timeout","retry_requested","observed"].includes(e.reason))
        .map(e=>({ts:e.ts,kind:e.kind,reason:e.reason,tabId:e.tabId,
          ...(e.kind==="conversation_title" && typeof e.conversationTitle==="string" &&
            e.conversationTitle.length<=120?{conversationTitle:e.conversationTitle}:{}),
          ...(typeof e.durationMs==="number"?{durationMs:e.durationMs}:{}),
          ...(typeof e.status==="number"?{status:e.status}:{})})).slice(-5000);
      setBrowserEvents(accepted);
    }catch{setBrowserError("无法读取指定格式的浏览器元数据");}
  }
  const durations=d.diagnostics.events.filter(e=>e.event==="mcp_finished" && typeof e.durationMs==="number").map(e=>e.durationMs!);
  const percentile=(p:number)=>durations.length ? [...durations].sort((a,b)=>a-b)[Math.floor((durations.length-1)*p)]!+" ms" : "—";
  return <div className="stack"><div className="notice"><strong>把卡顿定位到正确层级</strong>
    <p>工具执行结束且 HTTP 200，说明 Synrex 已返回；它无法证明 ChatGPT 模型或界面已经继续。</p></div>
    <div className="metrics"><Metric label="诊断事件" value={d.diagnostics.count} info="当前读取窗口" symbol="⌁"/>
      <Metric label="HTTP p50" value={percentile(.5)} info="近期请求" symbol="◷"/>
      <Metric label="HTTP p95" value={percentile(.95)} info="近期请求" symbol="◷"/>
      <Metric label="HTTP p99" value={percentile(.99)} info="样本量有限" symbol="◷"/></div>
    <Panel title="MCP 请求时间线" hint="点击请求查看已记录阶段"
      extra={<div><input className="filter" placeholder="按请求 ID 或工具筛选" value={query} onChange={e=>setQuery(e.target.value)}/>
        <button disabled={!/^[a-zA-Z0-9_-]{1,110}$/.test(query)} onClick={()=>setSelected(query)}>按 ID 查 7 天 Trace</button></div>}>
      {matched.map(r=><button className={`pick ${chosen===r.requestId?"picked":""}`} key={r.requestId} onClick={()=>setSelected(r.requestId)}><span className="round-symbol">⌁</span>
        <div className="grow"><strong>{r.tool??"MCP 请求"}</strong>
          <small>对话：{r.conversationTitle??"未关联（宿主未提供标题）"}</small>
          <small>{r.requestId}</small>
          {r.taskId&&<small>Task: {r.taskId}</small>}</div><Badge value={r.classification}/><time>{time(r.lastAt)}</time></button>)}
      {!matched.length&&<Blank>没有匹配的请求记录</Blank>}
    </Panel>
    <Panel title="对话标题关联" hint="宿主标题优先；没有宿主元数据时可手动登记准确标题，不根据任务内容推测">
      <p>当前请求：<code>{chosen??"未选择"}</code>。已知标题：<strong>{detail?.conversationTitle??"未知"}</strong>
        {detail?.titleSource&&<small>（{detail.titleSource==="owner"?"手动登记":detail.titleSource==="host"?"宿主提供":"尚未关联"}）</small>}</p>
      <div className="list-row">
        <input className="filter" style={{flex:1}} maxLength={120} placeholder="输入此对话在 ChatGPT 中的实际标题"
          value={titleDraft} onChange={e=>setTitleDraft(e.target.value)}/>
        <button disabled={!chosen||!titleDraft.trim()} onClick={()=>void labelSelected()}>保存标题关联</button>
      </div>
      {labelMessage&&<p className="footnote">{labelMessage}</p>}
      <p className="footnote">本操作仅绑定选中的请求 ID，不会自动把相邻时间的其他对话当作同一会话。</p>
    </Panel>
    <Panel title="关联事件" hint={detail?.truncated?"记录超过每次查询上限，显示最近 1000 条":"归档检索有窗口限制，缺失阶段保持未知"}>
      {spans.length>0&&<div style={{marginBottom:16}}>
        <strong>原生 OTel Span 瀑布图</strong>
        <p className="footnote">时间轴基于实际 Span 时间戳；并行阶段会重叠，不能直接相加。</p>
        {spans.slice(0,80).map(s=><div key={s.traceId+s.spanId} className="list-row">
          <span style={{width:112,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={s.name}>{s.name}</span>
          <div style={{height:14,position:"relative",background:"var(--surface,#edf1f4)",flex:1}}>
            <div title={s.durationMs+" ms · "+s.status} style={{position:"absolute",top:1,bottom:1,
              left:((Date.parse(s.ts)-origin)/total*100)+"%",
              width:Math.max(.5,s.durationMs/total*100)+"%",
              background:s.status==="error"?"#cf644e":"#6c8fac",borderRadius:3}}/>
          </div><small style={{width:65,textAlign:"right"}}>{Math.round(s.durationMs)} ms</small>
        </div>)}
      </div>}
      {trace.length?<div className="table-scroll"><table><thead><tr><th>时间</th><th>事件</th><th>阶段</th><th>耗时</th><th>状态</th></tr></thead><tbody>
        {trace.map((e,i)=><tr key={`${e.ts}-${i}`}><td>{time(e.ts)}</td><td>{e.event}</td><td>{e.stage??e.tool??"—"}</td>
          <td>{e.durationMs===undefined?"未知":`${e.durationMs} ms`}</td><td>{e.outcome??e.status??"—"}</td></tr>)}
      </tbody></table></div>:<Blank>当前窗口没有关联事件，不能据此认定请求未发生。</Blank>}
      {detail?.remoteState==="unavailable"&&<p className="footnote">gateway 历史查询不可用；已显示本地可用记录。</p>}
    </Panel>
    <Panel title="7 天历史检索" hint="SQLite 索引查询 · 500 条分页上限 · 默认近期">
      <div className="list-row"><input className="filter" placeholder="事件名，例如 mcp_failed" value={filter} onChange={e=>setFilter(e.target.value)}/>
        <label>起始 <input type="datetime-local" value={historyStart} onChange={e=>setHistoryStart(e.target.value)}/></label>
        <label>结束 <input type="datetime-local" value={historyEnd} onChange={e=>setHistoryEnd(e.target.value)}/></label>
        <button onClick={()=>void loadHistory()}>检索</button></div>
      {historyStats&&<p className="footnote">本机索引：{historyStats.events} 事件，{historyStats.spans} 原生 Span，
        {historyStats.metrics} 分钟级指标；gateway 历史查询：{historyPeer==="available"?"可用":"不可用"}。
        当前保留范围：{time(historyStats.first)} 至 {time(historyStats.last)}。</p>}
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>事件</th><th>节点</th><th>对话标题</th><th>请求 ID</th></tr></thead>
        <tbody>{history.slice(0,100).map((e,i)=><tr key={i}><td>{time(e.ts)}</td><td>{e.event}</td>
          <td>{e.nodeId??"swy1"}</td><td>{e.conversationTitle??"未知"}</td><td>{e.requestId??e.nodeRequestId??"—"}</td></tr>)}</tbody></table></div>
      {!history.length&&<Blank>点击“检索”可查询历史事件；未执行检索不代表没有日志。</Blank>}
    </Panel>
    <Panel title="浏览器消息流元数据" hint="手动导入扩展 JSON，不上传提示词和消息内容">
      <a href="/console/api/browser-extension" download="synrex-browser-observer.zip">
        下载浏览器观测扩展（安装需要用户自行确认）
      </a>
      <input type="file" accept=".json,application/json" onChange={e=>{
        const file=e.currentTarget.files?.[0];if(file)void loadBrowserMetadata(file);
      }}/>
      {browserError&&<p className="form-error">{browserError}</p>}
      <p className="footnote">浏览器扩展需由用户自行在 Chrome 启用。无共享请求 ID 的事件仅按时间推测关联。</p>
      {relatedBrowser.some(e=>e.conversationTitle)&&<p className="footnote">
        观测到的浏览器对话标题：
        {[...new Set(relatedBrowser.map(e=>e.conversationTitle).filter(Boolean))].slice(0,5).join("、")}。
        这些仅是时间上接近的候选标题，不代表已关联到当前请求。
      </p>}
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>来源</th><th>结果</th><th>耗时</th></tr></thead>
        <tbody>{relatedBrowser.slice(-40).map((e,i)=><tr key={i}>
          <td>{time(new Date(e.ts).toISOString())}</td><td>{e.kind}</td><td>{e.reason}</td>
          <td>{e.durationMs===undefined?"未知":e.durationMs+" ms"}</td></tr>)}</tbody></table></div>
      {browserEvents.length>0&&!relatedBrowser.length&&<Blank>已导入 {browserEvents.length} 条；当前请求时间窗口无匹配。</Blank>}
    </Panel></div>;
}
function Resources({d}:{d:Snapshot}) {
  const [host,setHost]=useState("swy1");
  const runtime=d.observability.runtime;
  const latestNodeNetwork=d.diagnostics.events.find(e=>e.event==="network_sampled"&&(e.nodeId??"swy1")===host);
  const networkStatus=latestNodeNetwork??(host==="swy1"?d.observability.network:{});
  const mib=(bytes?:number)=>bytes===undefined?"未知":(bytes/1048576).toFixed(1)+" MiB";
  const runtimeSamples=d.diagnostics.events.filter(e=>e.event==="runtime_sampled"&&typeof e.rssBytes==="number"&&
    (e.nodeId??"swy1")===host);
  const latestBoot=runtimeSamples[0]?.bootId;
  const samples=runtimeSamples.filter(e=>!latestBoot||e.bootId===latestBoot)
    .slice().reverse().slice(-50);
  const max=Math.max(1,...samples.map(e=>e.rssBytes!));
  const points=samples.map((e,i)=>`${samples.length===1?0:i*600/(samples.length-1)},${110-100*e.rssBytes!/max}`).join(" ");
  const latest=new Map<string,Snapshot["observability"]["metrics"][number]>();
  for(const sample of d.observability.metrics){
    const key=[sample.nodeId,sample.processPid,sample.name].join(":");
    if(!latest.has(key)||latest.get(key)!.ts<sample.ts)latest.set(key,sample);
  }
  const processMetrics=[...latest.values()].filter(e=>e.processPid!==undefined)
    .sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,30);
  const network=[...latest.values()].filter(e=>e.name.startsWith("system.network"))
    .sort((a,b)=>a.name.localeCompare(b.name)).slice(0,18);
  const tunnelFailures=d.diagnostics.events.filter(e=>e.event==="tunnel_auth_failed"||e.event==="tunnel_disconnected");
  return <div className="stack">
    <div className="notice"><strong>采集范围：可控主机与进程</strong><p>
      Collector：{d.observability.collector==="bounded_tail"?"本地归档可读取（仅尾部窗口）":"尚无本地归档数据"}。
      gateway 元数据：{d.observability.peerSync.gateway==="current"?"最近同步":d.observability.peerSync.gateway==="stale"?"已过期":"尚无同步"}。
      网络计数器不能替代单次 MCP 请求 RTT；缺失数据显示“未知”。</p></div>
    <label>节点 <select className="filter" value={host} onChange={e=>setHost(e.target.value)}>
      <option value="swy1">swy1</option><option value="gateway">gateway（近一分钟元数据）</option>
    </select></label>
    <div className="metrics">
      <Metric symbol="▥" label="Synrex RSS" value={host==="swy1"?mib(runtime.rssBytes):"未知"} info={host==="swy1"?time(runtime.at):"gateway 未部署新版进程埋点"}/>
      <Metric symbol="▦" label="JS Heap" value={host==="swy1"?mib(runtime.heapUsedBytes):"未知"} info={host}/>
      <Metric symbol="◷" label="事件循环采样延迟" value={host==="swy1"&&runtime.eventLoopLagMs!==undefined?runtime.eventLoopLagMs+" ms":"未知"} info="10 秒采样偏移"/>
      <Metric symbol="⌁" label="正在执行工具" value={host==="swy1"?runtime.activeToolCount??"未知":"未知"} info="采样时刻的活动数量"/>
    </div>
    <Panel title="进程内存曲线" hint="真实采集记录 · 同一服务实例 · 采样缺失处不插值">
      {samples.length>=2?<svg role="img" aria-label="Synrex 内存采样历史曲线"
        viewBox="0 0 600 120" preserveAspectRatio="none" style={{width:"100%",height:140}}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
      </svg>:<Blank>运行版本尚未产生足够的资源采样。</Blank>}
    </Panel>
    <div className="metrics">
      <Metric symbol="◷" label="TCP RTT p95" value={networkStatus.tcpRttP95Ms===undefined?"未知":networkStatus.tcpRttP95Ms+" ms"}
        info="主机已建立连接样本，非 MCP 请求 RTT"/>
      <Metric symbol="⌁" label="TCP 已采样连接" value={networkStatus.tcpConnections??"未知"} info={time(latestNodeNetwork?.ts??(host==="swy1"?d.observability.network.at:undefined))}/>
      <Metric symbol="▥" label="重传连接数" value={networkStatus.tcpRetransSockets??"未知"} info="采样窗口"/>
      <Metric symbol="◷" label="GC 耗时" value={host==="swy1"&&runtime.gcDurationMs!==undefined?runtime.gcDurationMs+" ms":"未知"} info="最近 10 秒采样区间"/>
    </div>
    <Panel title="采集完整性" hint="Collector 计数器 · 计数非零表示存在丢失风险，并非全部丢失量">
      <div className="metrics">
        <Metric symbol="⌁" label="拒收日志" value={d.observability.collectorHealth.refusedLogs??"未知"} info="Collector 累计计数"/>
        <Metric symbol="⌁" label="拒收指标" value={d.observability.collectorHealth.refusedMetrics??"未知"} info="Collector 累计计数"/>
        <Metric symbol="⌁" label="导出失败" value={d.observability.collectorHealth.exporterFailed??"未知"} info={time(d.observability.collectorHealth.at)}/>
        <Metric symbol="⌁" label="原生 Span 丢弃" value={runtime.otelSpanDropped??"未知"} info="Synrex 运行实例累计"/>
      </div>
    </Panel>
    <Panel title="Cloudflare 隧道异常" hint="区别正式入口与辅助测试隧道；仅本次快照中可见的最近事件">
      {tunnelFailures.length?<div className="table-scroll"><table><thead><tr><th>时间</th><th>服务</th><th>事件</th></tr></thead>
        <tbody>{tunnelFailures.slice(0,25).map((e,i)=><tr key={i}><td>{time(e.ts)}</td>
          <td>{e.tunnelUnit??"未知"}</td><td>{e.event}</td></tr>)}</tbody></table></div>
        :<Blank>当前采样窗口没有隧道异常记录，不代表完整历史没有故障。</Blank>}
    </Panel>
    <div className="columns">
      <Panel title="活动进程指标" hint="来自 Collector 的 PID 采样；不等于任务存活证明">
        <div className="table-scroll"><table><thead><tr><th>进程</th><th>PID</th><th>指标</th><th>数值</th></tr></thead>
          <tbody>{processMetrics.map((e,i)=><tr key={i}><td>{e.processName??"未知"}</td><td>{e.processPid}</td>
            <td>{e.name}</td><td>{Math.round(e.value).toLocaleString()}</td></tr>)}</tbody></table></div>
        {!processMetrics.length&&<Blank>尚未收到可识别 PID 的进程指标。</Blank>}
      </Panel>
      <Panel title="网络指标" hint="网络吞吐、错误与连接计数 · 不估计单次请求 RTT">
        <div className="table-scroll"><table><thead><tr><th>指标</th><th>节点</th><th>值</th></tr></thead>
          <tbody>{network.map((e,i)=><tr key={i}><td>{e.name}</td><td>{e.nodeId??"本机"}</td>
            <td>{Math.round(e.value).toLocaleString()}</td></tr>)}</tbody></table></div>
        {!network.length&&<Blank>Collector 网络数据尚不可用。</Blank>}
      </Panel>
    </div>
  </div>;
}
function Memory({d}:{d:Snapshot}) {
  return <div className="stack"><div className="metrics">
    <Metric symbol="◇" label="学习记录" value={d.memory.episodes} info="历史执行事件"/>
    <Metric symbol="✓" label="成功记录" value={d.memory.successful} info="不等于验证过的知识"/>
    <Metric symbol="☷" label="候选经验" value={d.memory.candidates} info="待审核"/>
    <Metric symbol="⬡" label="已晋升经验" value={d.memory.promoted} info="需保留证据"/>
  </div><Panel title="记忆与项目约束" hint="一个执行平台，一份真实来源">
    <div className="memory-intro"><span className="round-symbol large">◇</span><div><h2>让经验有来源、有验证。</h2>
      <p>Synrex 复用 AGENTS.md、项目架构约束、LearningStore 和工作流检查点。原始运行日志不等于长期知识；
      后续将支持提炼、审核、关系浏览和来源追踪，不重复建设另一套记忆服务。</p>
      <div className="tags"><span>Architecture</span><span>LearningStore</span><span>Evidence</span><span>Git</span></div></div></div>
    <p className="footnote">仅展示现有统计数据。不伪造知识关系，也不自动推广未经验证的操作经验。</p>
  </Panel></div>;
}
function App() {
  const [auth,setAuth]=useState<boolean|null>(null);
  const [data,setData]=useState<Snapshot|null>(null);
  const [view,setView]=useState<View>("overview");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const refresh=useCallback(async()=>{
    setLoading(true);
    try { const response=await getJson<Snapshot>("/console/api/snapshot");
      setData(response);setAuth(true);setError(""); }
    catch(e) { if(e instanceof Error&&e.message==="AUTH_REQUIRED")setAuth(false);
      else setError("读取系统状态失败，请手动刷新。"); }
    finally {setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(!auth) return; const timer=window.setInterval(()=>{
    if(!document.hidden)void refresh();
  },10000);return ()=>window.clearInterval(timer);},[auth,refresh]);
  async function logout(){
    try {await getJson("/console/api/logout",{method:"POST",headers:{"content-type":"application/json"}});}
    finally {setAuth(false);setData(null);}
  }
  if(auth===null) return <main className="boot">正在连接 Synrex…</main>;
  if(!auth) return <Login done={()=>void refresh()}/>;
  const meta=menus.find(x=>x.id===view)!;
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">S</div>
    <div><strong>SYNREX<span>.</span></strong><small>CONTROL PLANE</small></div></div>
    <p className="sidebar-label">WORKSPACE</p><nav aria-label="Synrex 管理导航">
      {menus.map(item=><button key={item.id} className={`nav-item ${view===item.id?"active":""}`}
        onClick={()=>setView(item.id)} aria-current={view===item.id?"page":undefined}>
        <span className="nav-symbol">{item.symbol}</span>{item.title}</button>)}</nav>
    <div className="sidebar-bottom"><div className="owner"><span className="round-symbol">♙</span><div><strong>Owner Access</strong><small>只读控制台</small></div></div>
      <button onClick={()=>void logout()}>退出登录 ↗</button></div>
  </aside><main className="main"><header className="topbar"><span>Synrex Console <b>/</b> <strong>{meta.title}</strong></span>
    <div><span className="online-dot"/> 连接正常 <button className="refresh" disabled={loading} onClick={()=>void refresh()}>{loading?"刷新中…":"↻ 刷新"}</button></div>
  </header><div className="content"><div className="heading"><p className="eyebrow">SYNREX OPERATIONS / {view.toUpperCase()}</p>
    <h1>{view==="overview"?"开发环境，一目了然。":meta.title}</h1>
    <div className="heading-line"><p>{view==="overview"?"主机、执行、工作流与诊断，一站式掌控。":meta.caption+" · 显示已有的真实数据"}</p>
      <span>更新于 {time(data?.generatedAt)}</span></div></div>
    {error&&<div className="error-banner" role="alert">{error} <button onClick={()=>void refresh()}>重试</button></div>}
    {data?<>{view==="overview"&&<Overview d={data} go={setView}/>}
      {view==="workflows"&&<Workflows d={data}/>}
      {view==="tasks"&&<Tasks d={data}/>}
      {view==="nodes"&&<Nodes d={data}/>}
      {view==="diagnostics"&&<Diagnostics d={data}/>}
      {view==="resources"&&<Resources d={data}/>}
      {view==="memory"&&<Memory d={data}/>}</>:<Blank>暂无系统数据</Blank>}
    <footer className="content-footer">Synrex Console · {data?.service.release??"离线"} <span>READ ONLY · GPT IS THE ORCHESTRATOR</span></footer>
  </div></main></div>;
}
const container=document.getElementById("app");
if(container)createRoot(container).render(<App/>);
