import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./console-app.css";
import { parseHar, type BrowserEvent } from "./browser-trace.js";
import { detectBrowserIncidents } from "./browser-incidents.js";

type View = "overview" | "workflows" | "tasks" | "nodes" | "diagnostics" | "memory";
type Snapshot = {
  generatedAt: string;
  service: { status: string; release: string };
  nodes: Array<{ id: string; alias: string; kind: string; health: string; os: string; lastSeenAt: string;
    contract: { matching: number; missing: number; incompatible: number; total: number }; version: string | null }>;
  workflows: Array<{ id: string; title: string; goal: string; workspace: string; status: string; revision: number;
    phase: string; summary: string; nextSteps: string[]; blockers: string[]; taskIds: string[]; updatedAt: string }>;
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string; status: string; lastUpdatedAt?: string }>;
  memory: { episodes: number; successful: number; candidates: number; promoted: number };
  diagnostics: { count: number; observability?: { coverage: { observedEvents:number; observedRequests:number; tokenUsage:string; hostInference:string }; latency: { completed:number; medianMs:number|null; p95Ms:number|null; maximumMs:number|null }; lifecycle: { httpCompleted:number; closedEarly:number; handlerFailed:number; toolCompletedWithoutHttp:number; unknown:number }; transfer: { observedInputBytes:number; observedOutputBytes:number; approximateInputTokens:number|null; approximateOutputTokens:number|null } }; requests: Array<{ requestId: string; tool?: string; lastAt: string; taskId?: string;
    classification: string; status?: number }> };
};
const menus: Array<{ id: View; title: string; symbol: string; caption: string }> = [
  { id: "overview", title: "总览", symbol: "▦", caption: "系统状态" },
  { id: "workflows", title: "工作流", symbol: "☷", caption: "任务与检查点" },
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
  const [showHistory,setShowHistory]=useState(false);
  const visible=showHistory?d.tasks:d.tasks.filter(t=>t.status==="working"||t.status==="input_required");
  return <Panel title="持久任务监控" hint="默认只展示本机状态文件确认仍在执行的任务；历史记录不混入活动列表">
    <p>已确认运行 {d.tasks.filter(t=>t.status==="working"||t.status==="input_required").length} 项（只覆盖最近登记的本机任务） ·
      <button onClick={()=>setShowHistory(v=>!v)}>{showHistory?"隐藏历史任务":"查看历史任务及未确认记录"}</button></p>
    <div className="table-scroll"><table><thead><tr><th>任务 ID</th><th>执行节点</th><th>状态（本机证据）</th><th>Run ID</th><th>创建时间</th></tr></thead>
    <tbody>{visible.map(t=><tr key={t.id}><td><code title={t.id}>{t.id.slice(0,23)}…</code></td>
      <td>{names.get(t.nodeId)??t.nodeId}</td><td>{t.status==="unknown"?"未确认":t.status==="stale_unverified"?"心跳过期 / 待核验":t.status}</td><td><code>{t.runId??"—"}</code></td><td>{time(t.createdAt)}</td></tr>)}</tbody></table></div>
    {!visible.length&&<Blank>{showHistory?"暂无任务索引":"没有状态文件确认的活动任务；远程任务可能未纳入"}</Blank>}
    <p className="footnote">此表为历史任务索引，不表示进程正在运行。实际活动进程需要独立的实时进程源，不应依据索引判断。</p>
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
function Diagnostics({d,clockOffsetMs,clockUncertaintyMs}:{d:Snapshot;clockOffsetMs:number|null;clockUncertaintyMs:number|null}) {
  const [query,setQuery]=useState("");
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
        <Metric label="GPT Token 用量" value="不可观测" info="MCP 字节数不等于模型 Token；无法观察 GPT 推理" symbol="∅"/>
      </div>
      <p className="footnote">已观测 MCP 输入 {d.diagnostics.observability.transfer.observedInputBytes.toLocaleString()} B、输出 {d.diagnostics.observability.transfer.observedOutputBytes.toLocaleString()} B；覆盖 {d.diagnostics.observability.coverage.observedRequests} 个请求。仅有 HTTP 完成证据时，模型推理中断与 ChatGPT 消息断流仍不可区分，需结合浏览器 HAR。</p>
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
          <small>{new Date(i.at).toLocaleString()} · {i.events.length} 条上下文请求</small></div>
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
    <Panel title="MCP 请求时间线" hint="最小可用诊断 · 约 2 MB 滚动容量"
      extra={<input className="filter" placeholder="按请求或工具筛选" value={query} onChange={e=>setQuery(e.target.value)}/>}>
      {matched.map(r=><div className="list-row" key={r.requestId}><span className="round-symbol">⌁</span>
        <div className="grow"><strong>{r.tool??"MCP 请求"}</strong><small>{r.requestId}</small>
          {r.taskId&&<small>Task: {r.taskId}</small>}</div><Badge value={r.classification}/><time>{time(r.lastAt)}</time></div>)}
      {!matched.length&&<Blank>没有匹配的请求记录</Blank>}
    </Panel></div>;
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
  const [clockOffsetMs,setClockOffsetMs]=useState<number|null>(null);
  const [clockUncertaintyMs,setClockUncertaintyMs]=useState<number|null>(null);
  const refresh=useCallback(async()=>{
    setLoading(true);
    try { const response=await getJson<Snapshot>("/console/api/snapshot");
      setData(response);setAuth(true);setError(""); }
    catch(e) { if(e instanceof Error&&e.message==="AUTH_REQUIRED")setAuth(false);
      else setError("读取系统状态失败，请手动刷新。"); }
    finally {setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{
    if(auth!==true)return;
    let alive=true;
    let inFlight=false;
    const update=async()=>{
      if(inFlight || document.visibilityState==="hidden")return;
      inFlight=true;
      const before=Date.now();
      try {
        if(view==="diagnostics") {
          const clock=await getJson<{serverTimeMs:number}>("/console/api/clock");
          const after=Date.now();
          if(!alive)return;
          if(Number.isFinite(clock.serverTimeMs)) {
            setClockOffsetMs((before+after)/2-clock.serverTimeMs);
            setClockUncertaintyMs((after-before)/2);
          }
        }
        const snapshot=await getJson<Snapshot>("/console/api/snapshot");
        if(alive){setData(snapshot);setError("");}
      } catch { if(alive)setError("实时数据更新失败，当前显示的是上一次快照。"); }
      finally {inFlight=false;}
    };
    void update();
    const timer=setInterval(()=>void update(),5000);
    const onVisible=()=>{if(document.visibilityState==="visible")void update();};
    document.addEventListener("visibilitychange",onVisible);
    return()=>{alive=false;clearInterval(timer);document.removeEventListener("visibilitychange",onVisible);};
  },[auth,view]);
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
      {view==="diagnostics"&&<Diagnostics d={data} clockOffsetMs={clockOffsetMs} clockUncertaintyMs={clockUncertaintyMs}/>}
      {view==="memory"&&<Memory d={data}/>}</>:<Blank>暂无系统数据</Blank>}
    <footer className="content-footer">Synrex Console · {data?.service.release??"离线"} <span>READ ONLY · GPT IS THE ORCHESTRATOR</span></footer>
  </div></main></div>;
}
const container=document.getElementById("app");
if(container)createRoot(container).render(<App/>);
