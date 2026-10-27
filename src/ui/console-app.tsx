import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { analyzeBrowserTransport } from "../browser-transport-analysis.js";
import { LegacyDiagnostics } from "./console-legacy-diagnostics.js";
import "./console-app.css";

type View = "overview" | "usage" | "workflows" | "tasks" | "nodes" | "diagnostics" | "correlation" | "resources" | "logs" | "memory" | "windows";
type Usage = {generatedAt?:string;status?:string;requests?:number;completed?:number;failed?:number;toolCalls?:number;
  mcpWire?:{inputBytes:number;outputBytes:number;observedInputRequests:number;observedOutputRequests:number};
  duration?:{observedRequests:number;meanMs:number|null};
  modelTokens?:{input:null;output:null;reason:string};
  comparison?:{baseline:null;savingsPercent:null;reason:string};
  code?:{commits:number;added:number;deleted:number;net:number;fileChanges:number;warning:string}|null};
type ObservedSpan = {ts:string;traceId:string;spanId:string;parentSpanId?:string;
  name:string;durationMs:number;status:string;requestId?:string};
type BrowserEvent = {ts:number;kind:"network"|"ui"|"conversation_title"|"tab"|"health";
  reason:string;tabId?:number;flowId?:string;endpointGroup?:string;requestType?:string;
  durationMs?:number;status?:number;errorCategory?:string;netError?:string;startedAt?:string;
  host?:string;conversationTitle?:string};
type UsagePeriod = "24h" | "7d" | "30d";
type UsageTotals = { requests:number; completed:number; toolExecutions:number; inputBytes:number; outputBytes:number;
  measuredInput:number;measuredOutput:number;
  payloadTokenEquivalentInput:number;payloadTokenEquivalentOutput:number;gitReviews:number;reviewedFileTouches:number;
  distinctReviewedFiles:number;distinctFileCountComplete:boolean;addedLines:number;removedLines:number;otherEditOperations:number;
  projects:Array<{id:string;name:string;reviews:number;fileTouches:number;uniqueFiles:number;addedLines:number;removedLines:number;editOperations:number}>;
  topTools:Array<{tool:string;calls:number}>;
  trends:Array<{day:string;requests:number;toolExecutions:number;addedLines:number;removedLines:number}> };
type Snapshot = {
  generatedAt: string;
  dataFreshness?: {sampledAt:string;nodes:string|null;workflows:string|null;tasks:string|null;
    diagnostics:string|null;runtime:string|null};
  snapshotStale?: boolean;
  service: { status: string; release: string };
  nodes: Array<{ id: string; alias: string; kind: string; health: string; os: string; lastSeenAt: string;
    contract: { matching: number; missing: number; incompatible: number; total: number }; version: string | null }>;
  workflows: Array<{ id: string; title: string; goal: string; workspace: string; status: string; revision: number;
    phase: string; summary: string; nextSteps: string[]; blockers: string[]; taskIds: string[]; checks:string[]; acceptanceCriteria:string[]; updatedAt: string }>;
  conversationSessions: Array<{id:string;title:string;lastAt:string;requestCount:number;runningTasks:number;state:string;requests:Array<{requestId:string;tool?:string;lastAt:string;taskId?:string;runId?:string;classification:string}>}>;
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string; status: string; lastUpdatedAt?: string; lastActivityAt?: string; childPid?:number; exitCode?:number|null; statusSource:string }>;
  activeTaskUnits?: string[] | null;
  activeTaskProcesses?: Array<{unit:string;pid:number|null;memoryBytes:number|null;cpuTimeMs:number|null}> | null;
  execution?: { workflowCompleted:number; workflowBlocked:number; workflowActive:number; workflowCancelled:number;
    selfReportedCompletionRate:number|null; confirmedTaskSuccesses:number; confirmedTaskFailures:number;
    failureCategories:Record<string,number>; manualReminders:null; observedWindow:string;taskSourceCoverage:string };
  timeline?:Array<{at:string;kind:string;taskId?:string;runId?:string;nodeId?:string;errorCategory?:string;exitCode?:number;outcome?:string}>;
  memory: { episodes: number; successful: number; notes: number; candidates: number; promoted: number };
  usage?: { source:{diagnosticFirstAt:string|null;episodeFirstAt:string|null;diagnosticsCapped:boolean;episodesCapped:boolean;
    trafficPersistedFrom:string|null;codePersistedFrom:string|null;codeReviewsCapped:boolean};
    periods:Record<UsagePeriod,UsageTotals>;
    inference:{inputTokens:null;outputTokens:null;model:null;explanation:string} };
  diagnostics: { count: number; observability?: {coverage:{observedEvents:number;observedRequests:number;tokenUsage:string;hostInference:string};
    latency:{completed:number;medianMs:number|null;p95Ms:number|null;maximumMs:number|null};
    lifecycle:{httpCompleted:number;closedEarly:number;handlerFailed:number;toolCompletedWithoutHttp:number;unknown:number};
    transfer:{observedInputBytes:number;observedOutputBytes:number;approximateInputTokens:number|null;approximateOutputTokens:number|null};
    capacity?:{inputP95:number|null;outputP95:number|null;largestOutput:number;largeResponses:number;bytesPerSecond:number|null} };
    requests: Array<{ requestId: string; tool?: string; lastAt: string; taskId?: string;
    conversationTitle?:string; conversationId?:string; runId?:string;
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
const coreMenus: Array<{ id: View; title: string; symbol: string; caption: string }> = [
  { id: "overview", title: "总览", symbol: "▦", caption: "系统状态" },
  { id: "usage", title: "用量与产出", symbol: "▤", caption: "MCP 用量与 Git 产出" },
  { id: "workflows", title: "工作流", symbol: "☷", caption: "任务与检查点" },
  { id: "tasks", title: "执行索引", symbol: ">_", caption: "持久任务位置" },
  { id: "nodes", title: "主机节点", symbol: "⌘", caption: "版本与契约" },
  { id: "diagnostics", title: "诊断中心", symbol: "⌁", caption: "MCP 时间线" },
  { id: "correlation", title: "关联排障", symbol: "⌁", caption: "浏览器与 MCP 因果关系" },
  { id: "resources", title: "资源与网络", symbol: "▥", caption: "进程 / CPU / 网络" },
  { id: "logs", title: "Synrex 日志", symbol: "≡", caption: "事件历史与服务日志" },
  { id: "memory", title: "记忆与治理", symbol: "◇", caption: "学习证据" },
];
const windowsMenu = { id: "windows" as const, title: "Windows 运维", symbol: "⊞", caption: "连接 / Tunnel / 服务 / 设置" };
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
function UsagePage(){
  const [data,setData]=useState<Usage|null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    const load=()=>getJson<Usage>("/console/api/usage").then(x=>{if(live){setData(x);setError("");}})
      .catch(()=>{if(live)setError("离线统计暂不可用");});
    void load();const timer=setInterval(()=>void load(),60000);
    return()=>{live=false;clearInterval(timer);};
  },[]);
if(error)return <Blank>{error}</Blank>;
  if(!data||data.status)return <Blank>等待独立统计进程首次生成数据，不在 MCP 主进程中计算。</Blank>;
  const age=Date.now()-Date.parse(data.generatedAt??"");
const format=(n?:number|null)=>n===undefined||n===null?"未知":n.toLocaleString("zh-CN");
  return <div className="stack">
    <Panel title="7 天执行效率" hint="后台独立进程生成，只读取缓存；不会调用模型，也不会占用上下文">
      <p className="footnote">更新于 {time(data.generatedAt)}；统计口径为服务端实际观测的 MCP 请求。</p>
      {(!Number.isFinite(age)||age>11*60*1000)&&<p role="alert" className="error-banner">
        统计源已超过 11 分钟未更新，展示的是历史缓存，不能当作实时指标。</p>}
      <div className="metrics">
        <Metric label="MCP 请求" value={format(data.requests)} info="服务端观测" symbol="▤"/>
        <Metric label="已完成" value={format(data.completed)} info="HTTP 完成，不代表模型成功" symbol="✓"/>
        <Metric label="失败" value={format(data.failed)} info="已记录失败" symbol="!"/>
        <Metric label="工具调用" value={format(data.toolCalls)} info="执行完成事件" symbol="⌘"/>
        <Metric label="平均 MCP 耗时" value={data.duration?.meanMs==null?"未知":data.duration.meanMs+" ms"}
          info="仅统计可观测请求" symbol="◷"/>
      </div>
    </Panel>
    <Panel title="Token 与传输开销" hint="真实模型 Token 不可观测时保持未知，不把网络字节伪装成 Token">
      <div className="metrics">
        <Metric label="输入 Token" value="未知" info="宿主未开放用量" symbol="↗"/>
        <Metric label="输出 Token" value="未知" info="宿主未开放用量" symbol="↙"/>
        <Metric label="MCP 输入流量" value={format(data.mcpWire?.inputBytes)+" B"} info="HTTP 请求字节" symbol="⇢"/>
        <Metric label="MCP 输出流量" value={format(data.mcpWire?.outputBytes)+" B"} info="HTTP 响应字节" symbol="⇠"/>
      </div>
      <p className="footnote">输入字节覆盖 {format(data.mcpWire?.observedInputRequests)} 次请求；
        输出字节覆盖 {format(data.mcpWire?.observedOutputRequests)} 次请求。仅作为传输开销，不推断模型推理 Token。</p>
    </Panel>
    <Panel title="代码产出" hint="Git 七天提交记录，不将改动行数直接等同于有效代码">
      {data.code?<><div className="metrics">
        <Metric label="提交" value={format(data.code.commits)} info="不含合并提交" symbol="◇"/>
        <Metric label="新增行" value={format(data.code.added)} info="Git numstat" symbol="+"/>
        <Metric label="删除行" value={format(data.code.deleted)} info="Git numstat" symbol="−"/>
        <Metric label="净变动" value={format(data.code.net)} info="新增减删除" symbol="≡"/>
      </div><p className="footnote">{data.code.warning}</p></>:<Blank>未配置仓库路径，暂无可验证代码统计。</Blank>}
    </Panel>
    <Panel title="GPT / Codex 对照" hint="对照数据未采集前不展示虚构的节省百分比">
      <Blank>{data.comparison?.reason??"尚无可比较的基线数据"}</Blank>
    </Panel>
  </div>;
}
async function getJson<T>(url:string, init?:RequestInit):Promise<T> {
  const r=await fetch(url,{ credentials:"same-origin",cache:"no-store",...init });
  if(!r.ok) throw new Error(r.status===401?"AUTH_REQUIRED":`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function postJson<T>(url:string, body:unknown):Promise<T> {
  return getJson<T>(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}

type WindowsStatus = {
  runtime?: {active_slot?:string;previous_slot?:string;pointer_mismatch?:boolean;actual?:{version?:string;package_root?:string}};
  services?: {devspace?:string;tunnel?:string};
  mcp?: {public_base_url?:string;local_health?:{ok?:boolean;status?:number};public_health?:{ok?:boolean;status?:number}};
  tunnel?: {metrics?:{ha_connections?:number};diagnostics?:{actual_protocol?:string;registered_connections?:number;last_registered_at?:string}};
  management?: {settings?: {
    allowed_roots?:string[];local_port?:number;public_base_url?:string;effective_public_base_url?:string;
    tunnel_mode?:string;tunnel_token_present?:boolean;auto_start?:boolean|null;auto_start_available?:boolean;
    tool_mode?:string;review_ui_enabled?:boolean;skills_enabled?:boolean;skill_paths?:string[];
    logging?:{level?:string;format?:string;requests?:boolean;tool_calls?:boolean;shell_commands?:boolean};
  };paths?:Record<string,string>};
};
type ServiceLog = {service:string;log:string};
type HistoryPayload = {events:Array<{ts:string;event:string;requestId?:string;tool?:string;outcome?:string;stage?:string}>};
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
  const sources=[
    ["节点心跳",d.dataFreshness?.nodes],
    ["工作流检查点",d.dataFreshness?.workflows],
    ["已核验本地任务",d.dataFreshness?.tasks],
    ["MCP 诊断事件",d.dataFreshness?.diagnostics],
    ["Core 资源采样",d.dataFreshness?.runtime],
  ] as const;
  return <div className="stack">
    <div className="metrics">
      <Metric label="在线节点" value={`${online} / ${d.nodes.length}`} info="计算网络" symbol="⌘"/>
      <Metric label="标记 active 的工作流" value={active} info="持久检查点，不代表当前进程" symbol="☷"/>
      <Metric label="任务索引" value={d.tasks.length} info="最近 30 项" symbol=">_"/>
      <Metric label="待确认请求" value={d.diagnostics.requests.filter(x=>x.classification!=="rev_http_completed").length}
        info="诊断时间线" symbol="⌁"/>
    </div>
    {d.execution&&<div className="metrics">
      <Metric label="工作流自报完成率" value={d.execution.selfReportedCompletionRate===null?"无样本":d.execution.selfReportedCompletionRate+"%"}
        info="仅限最近保存的终态工作流，不是 GPT 真正成功率" symbol="☷"/>
      <Metric label="任务退出成功 / 失败" value={`${d.execution.confirmedTaskSuccesses} / ${d.execution.confirmedTaskFailures}`}
        info="仅已记录的任务终态；不是用户目标完成数" symbol=">_"/>
      <Metric label="阻塞工作流" value={d.execution.workflowBlocked} info="可从工作流继续" symbol="⌁"/>
      <Metric label="人工催促次数" value="不可观测" info="MCP 无法读取用户对话消息，不虚构统计" symbol="·"/>
    </div>}
    {d.execution&&Object.keys(d.execution.failureCategories).length>0&&<Panel title="可观察失败原因" hint="仅来自工具执行事件中的错误类别，不代表根因或用户目标失败">
      {Object.entries(d.execution.failureCategories).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>
        <div key={reason} className="list-row"><strong className="grow">{reason}</strong><span>{count} 次</span></div>)}
    </Panel>}
    <Panel title="数据源最近活动" hint="快照刷新不代表数据源有新事件；空闲不等于离线">
      <p className="footnote">快照读取：{time(d.dataFreshness?.sampledAt??d.generatedAt)}。下列时间分别来自原始数据源，不是页面刷新时间。</p>
      {sources.map(([label,lastAt])=><div className="list-row" key={label}>
        <strong className="grow">{label}</strong><span>{lastAt?time(lastAt):"无可核验数据"}</span>
      </div>)}
    </Panel>
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
        <p className="footnote">检查点最后更新：{time(current.updatedAt)}。工作流状态是历史保存值，并不证明任务当前仍在运行。</p>
        <p>{current.goal}</p><code className="id-block">{current.id}</code>
        <div className="checkpoint-block"><small>原始验收条件（需验证）</small><ol>{current.acceptanceCriteria.map((x,i)=><li key={i}>{x}</li>)}</ol></div>
        <div className="checkpoint-block"><small>当前阶段</small><strong>{current.phase||"—"}</strong><p>{current.summary}</p></div>
        <div className="checkpoint-block"><small>下一步</small>{current.nextSteps.length
          ?<ol>{current.nextSteps.map((x,i)=><li key={i}>{x}</li>)}</ol>:<p>没有剩余步骤</p>}</div>
        {current.blockers.length>0&&<div className="checkpoint-block"><small>阻塞事项</small><ul>{current.blockers.map((x,i)=><li key={i}>{x}</li>)}</ul></div>}
        <div className="checkpoint-block"><small>持久任务 ID</small><p>{current.taskIds.join(", ")||"无"}</p></div>
        <div className="checkpoint-block"><small>自报验证证据（非独立证明）</small><p>{current.checks.join("；")||"无"}</p></div>
        <p className="footnote">复制工作流 ID，在普通 GPT 对话中要求继续该任务即可。</p>
      </div>:<Blank>选择一个工作流查看</Blank>}
    </Panel>
   </div>;
}
function Tasks({d}:{d:Snapshot}) {
  const names=new Map(d.nodes.map(x=>[x.id,x.alias]));
  const processes=new Map((d.activeTaskProcesses??[]).map(x=>[x.unit,x]));
  const [showHistory,setShowHistory]=useState(false);
  const visible=showHistory?d.tasks:d.tasks.filter(t=>t.status==="working"||t.status==="input_required");
  return <div className="stack"><Panel title="持久任务监控" hint="本机任务文件与 systemd 进程分开确认；远程任务仅展示已证实状态">
    <p><strong>本机活动任务服务：</strong> {d.activeTaskUnits===undefined||d.activeTaskUnits===null?"无法读取":d.activeTaskUnits.length+" 个"}</p>
    {d.activeTaskUnits?.map(unit=>{const process=processes.get(unit);return <div className="list-row" key={unit}>
      <span className="online-dot"/><code>{unit}</code>
      <small>{process?.pid? `PID ${process.pid}` : "PID 未确认"} ·
        {process?.memoryBytes===null||process?.memoryBytes===undefined?"内存未知":`${(process.memoryBytes/1024/1024).toFixed(1)} MiB`} ·
        {process?.cpuTimeMs===null||process?.cpuTimeMs===undefined?"CPU 未知":`CPU ${process.cpuTimeMs} ms`}</small>
    </div>;})}
    <p>已登记运行中任务 {visible.filter(t=>t.status==="working"||t.status==="input_required").length} 项（以本机任务状态文件为准） ·
      <button onClick={()=>setShowHistory(v=>!v)}>{showHistory?"隐藏历史任务":"查看全部索引与历史"}</button></p>
    <div className="table-scroll"><table><thead><tr><th>任务 ID</th><th>执行节点</th><th>状态</th><th>PID / 退出码</th><th>Run ID</th><th>最近输出</th><th>创建时间</th></tr></thead>
    <tbody>{visible.map(t=><tr key={t.id}><td><code title={t.id}>{t.id.slice(0,23)}…</code></td>
      <td>{names.get(t.nodeId)??t.nodeId}</td><td>{t.status==="unknown"?"未确认":t.status==="remote_unverified"?"远程待核验":t.status==="stale_unverified"?"心跳过期 / 待核验":t.status}</td>
      <td>{t.childPid??(t.exitCode!==undefined?`exit ${t.exitCode}`:"—")}</td>
      <td><code>{t.runId??"—"}</code></td><td>{time(t.lastActivityAt)}</td><td>{time(t.createdAt)}</td></tr>)}</tbody></table></div>
    {!visible.length&&<Blank>{showHistory?"暂无任务索引":"没有登记为运行中的任务"}</Blank>}
    <p className="footnote">任务记录不是进程存活的证据；实际活动进程以上方 systemd 状态为准。远程节点需单独查询。</p>
  </Panel>
   <Panel title="执行事件时间线" hint="只读诊断事件，按记录时间倒序；点击 Run ID 可到诊断中心查日志">
    {(d.timeline??[]).slice(0,45).map((event,i)=><div className="list-row" key={event.at+"-"+i}>
      <span className="round-symbol">⌁</span><div className="grow">
        <strong>{event.kind}</strong>
        <small>{event.taskId??event.runId??event.nodeId??"无任务关联"} · {time(event.at)}</small>
      </div><small>{event.errorCategory??event.outcome??(event.exitCode!==undefined?`exit ${event.exitCode}`:"—")}</small>
    </div>)}
    {!d.timeline?.length&&<Blank>暂无带时间戳的执行事件</Blank>}
   </Panel></div>;
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
  const browserFindings=analyzeBrowserTransport(browserEvents);
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
    if(file.size>4*1024*1024){setBrowserError("文件超过 4 MiB 上限");return;}
    try{
      const data=JSON.parse(await file.text()) as {schema?:string;events?:BrowserEvent[]};
      if(data.schema!=="synrex.browser.v1"||!Array.isArray(data.events))throw Error("Invalid schema");
      const accepted=data.events.filter(e=>e && ["network","ui","conversation_title","tab","health"].includes(e.kind) &&
        typeof e.ts==="number"&&Number.isFinite(e.ts)&&
        ["started","headers_received","first_response","redirect","completed","handshake_completed","network_error",
          "transport_timeout","retry_requested","observed","heartbeat",
          "visible","hidden","pagehide","pageshow","incomplete"].includes(e.reason))
        .map(e=>({ts:e.ts,kind:e.kind,reason:e.reason,
          ...(typeof e.tabId==="number"?{tabId:e.tabId}:{}),
          ...(typeof e.flowId==="string"&&/^[0-9a-f-]{36}$/.test(e.flowId)?{flowId:e.flowId}:{}),
          ...(typeof e.endpointGroup==="string"&&["conversation","other","self_test","websocket_handshake"].includes(e.endpointGroup)
            ?{endpointGroup:e.endpointGroup}:{}),
          ...(typeof e.requestType==="string"?{requestType:e.requestType}:{}),
          ...(typeof e.errorCategory==="string"?{errorCategory:e.errorCategory}:{}),
          ...(typeof e.netError==="string"&&/^net::ERR_[A-Z0-9_]{2,60}$/.test(e.netError)?{netError:e.netError}:{}),
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
    {d.diagnostics.observability&&<Panel title="延迟、连接生命周期与传输量" hint="基于已记录的 MCP HTTP 事件；不代表 ChatGPT 内部 Token">
      <div className="metrics">
        <Metric label="MCP p50 / p95" value={`${d.diagnostics.observability.latency.medianMs??"—"} / ${d.diagnostics.observability.latency.p95Ms??"—"} ms`} info={`${d.diagnostics.observability.latency.completed} 个有耗时完成请求`} symbol="◷"/>
        <Metric label="完成 / 提前断开" value={`${d.diagnostics.observability.lifecycle.httpCompleted} / ${d.diagnostics.observability.lifecycle.closedEarly}`} info="Synrex 实际观察" symbol="⌁"/>
        <Metric label="执行错误 / 未确认" value={`${d.diagnostics.observability.lifecycle.handlerFailed} / ${d.diagnostics.observability.lifecycle.unknown}`} info="日志截断可产生未知" symbol="!"/>
        <Metric label="输出 p95" value={`${d.diagnostics.observability.capacity?.outputP95?.toLocaleString()??"—"} B`} info="响应体积，不是模型 Token" symbol="⇥"/>
      </div>
      <p className="footnote">可见输入 {d.diagnostics.observability.transfer.observedInputBytes.toLocaleString()} B、输出 {d.diagnostics.observability.transfer.observedOutputBytes.toLocaleString()} B；超出本机日志窗口的事件不做推断。</p>
    </Panel>}
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
<p className="footnote">扩展 v1.1：在 ChatGPT 标签页打开扩展并点击“测试实际页面网络采集”。
        看到通过后导出 JSON，再导入 Console。无共享请求 ID 的记录只按时间推测关联。</p>
      {browserEvents.length>0&&<p className="footnote">已导入 {browserEvents.length} 条；
        请求开始 {browserEvents.filter(e=>e.reason==="started").length}，
        首响应 {browserEvents.filter(e=>e.reason==="first_response").length}，
        结束 {browserEvents.filter(e=>e.reason==="completed"||e.reason==="network_error").length}，
        页面超时 {browserEvents.filter(e=>e.reason==="transport_timeout").length}。</p>}
      {browserFindings.map((f,i)=><p className="footnote" key={i}>
        超时诊断（{time(new Date(f.at).toISOString())}）：{f.description}
        候选流 {f.candidateFlows} 条，均非精确请求级归因。</p>)}
      {relatedBrowser.some(e=>e.conversationTitle)&&<p className="footnote">
        观测到的浏览器对话标题：
        {[...new Set(relatedBrowser.map(e=>e.conversationTitle).filter(Boolean))].slice(0,5).join("、")}。
        这些仅是时间上接近的候选标题，不代表已关联到当前请求。
      </p>}
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>来源</th><th>阶段</th><th>本地流 ID</th><th>耗时</th></tr></thead>
        <tbody>{(relatedBrowser.length?relatedBrowser:browserEvents.slice(-100)).slice(-60).map((e,i)=><tr key={i}>
          <td>{time(new Date(e.ts).toISOString())}</td><td>{e.endpointGroup??e.kind}</td>
          <td>{e.reason}{e.status!==undefined?" / HTTP "+e.status:""}
            {e.errorCategory?" / "+e.errorCategory:""}{e.netError?" / "+e.netError:""}</td>
          <td title={e.flowId??""}>{e.flowId?.slice(0,8)??"—"}</td>
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
function Usage({d}:{d:Snapshot}) {
  const [period,setPeriod]=useState<UsagePeriod>("7d");
  const [trend,setTrend]=useState<"requests"|"toolExecutions"|"changes">("requests");
  const [projectId,setProjectId]=useState("all");
  if(!d.usage)return <Blank>当前服务版本尚未提供用量快照。</Blank>;
  const totals=d.usage.periods[period];
  const selected=totals.projects.find(p=>p.id===projectId);
  const observedReviews=totals.gitReviews>0;
  const totalBytes=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(2)} MiB`:`${(bytes/1024).toFixed(1)} KiB`;
  const format=(n:number)=>n.toLocaleString("zh-CN");
  const trendValue=(item:UsageTotals["trends"][number])=>trend==="changes"?item.addedLines+item.removedLines:item[trend];
  const maxCalls=Math.max(1,...totals.trends.map(trendValue));
  const coverage=d.usage.source;
  const csv=(value:string|number)=>{
    const safe=String(value).replace(/\r|\n/g," ");
    return `"${/^[=+@\-]/.test(safe)?"'":""}${safe.replace(/"/g,'""')}\"`;
  };
  function exportCsv(){
    const rows:[string,...Array<string|number>][]=[
      ["kind","date_or_project","requests","tool_calls","git_reviews","file_touches","added_lines","removed_lines"],
      ...totals.trends.map(x=>["daily",x.day,x.requests,x.toolExecutions,"","",x.addedLines,x.removedLines] as [string,...Array<string|number>]),
      ...totals.projects.filter(p=>!selected||p.id===selected.id)
        .map(p=>["project",p.name,"","",p.reviews,p.fileTouches,p.addedLines,p.removedLines] as [string,...Array<string|number>]),
    ];
    const blob=new Blob(["\uFEFF",rows.map(row=>row.map(csv).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");link.href=url;link.download=`synrex-usage-${period}.csv`;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="stack">
    <Panel title="用量区间" hint="只读 · 已留存的 MCP 诊断和 Git 审阅记录；时间窗可能不完整"
      extra={<div className="usage-actions"><div className="usage-range" role="group" aria-label="统计周期">
        {(["24h","7d","30d"] as const).map(p=><button key={p} type="button" className={period===p?"selected":""}
          aria-pressed={period===p} onClick={()=>setPeriod(p)}>{p==="24h"?"24 小时":p==="7d"?"7 天":"30 天"}</button>)}
      </div><button type="button" className="refresh" onClick={exportCsv} aria-label="导出当前统计 CSV">导出 CSV ↓</button></div>}>
      <div className="usage-source-line">
        <span>流量：{coverage.trafficPersistedFrom?"小时汇总 + 历史补充":"诊断日志（非持久化历史）"}</span>
        <span>代码：{coverage.codePersistedFrom?"Git 审阅账本":"可用的学习记录"}</span>
        <span>推理 Token：不可观测</span>
      </div>
      <div className="metrics usage-metrics">
        <Metric symbol="⌁" label="MCP 请求" value={format(totals.requests)} info={`完成 ${format(totals.completed)} · 不等于模型调用`}/>
        <Metric symbol="↳" label="工具执行" value={format(totals.toolExecutions)} info="仅统计记录到的工具开始事件"/>
        <Metric symbol="↓" label="MCP 输入" value={totals.measuredInput?totalBytes(totals.inputBytes):"—"}
          info={totals.measuredInput?`测量 ${totals.measuredInput}/${totals.requests} 个请求 · 约 ${format(totals.payloadTokenEquivalentInput)} Token 当量`:"缺少 HTTP 输入体积记录"}/>
        <Metric symbol="↑" label="MCP 输出" value={totals.measuredOutput?totalBytes(totals.outputBytes):"—"}
          info={totals.measuredOutput?`测量 ${totals.measuredOutput}/${totals.completed} 个完成请求 · 约 ${format(totals.payloadTokenEquivalentOutput)} Token 当量`:"缺少 HTTP 输出体积记录"}/>
        <Metric symbol="▤" label="Git 审阅文件次数" value={observedReviews?format(totals.reviewedFileTouches):"—"} info={`来自 ${totals.gitReviews} 次不重复的 Git 审阅`}/>
        <Metric symbol="≡" label="不同文件（可识别）" value={observedReviews?`${totals.distinctFileCountComplete?"":"≥ "}${format(totals.distinctReviewedFiles)}`:"—"} info="工作区内路径指纹去重，可能不完整"/>
        <Metric symbol="+" label="新增代码行" value={observedReviews?`+${format(totals.addedLines)}`:"—"} info="Git 审阅区间内的新增行，不是历史总净增"/>
        <Metric symbol="−" label="删除代码行" value={observedReviews?`−${format(totals.removedLines)}`:"—"} info="Git 审阅区间内的删除行"/>
      </div>
      <p className="footnote">文件与行数来自后续产生的 <code>show_changes</code> Git 差异，历史未携带结构化统计的审阅不能追溯计算。其他被记录的编辑操作 {format(totals.otherEditOperations)} 次，不能直接折算为文件数或代码行；相同文件可能在多个审阅窗口反复变化。</p>
    </Panel>
    <div className="columns">
      <Panel title="用量与代码产出趋势" hint="UTC 日期 · 缺失日期不代表零调用"
        extra={<div className="usage-range" role="group" aria-label="图表指标">
          {([{id:"requests",text:"请求"},{id:"toolExecutions",text:"工具"},{id:"changes",text:"代码行"}] as const)
            .map(x=><button key={x.id} type="button" className={trend===x.id?"selected":""}
              aria-pressed={trend===x.id} onClick={()=>setTrend(x.id)}>{x.text}</button>)}
        </div>}>
        {totals.trends.length?<div className="usage-bars" role="img" aria-label="按日统计的 Synrex 用量">
          {totals.trends.slice(-30).map(x=><div className="usage-bar-col" key={x.day}
            title={`${x.day} UTC · 请求 ${x.requests} · 工具 ${x.toolExecutions} · 新增 ${x.addedLines} · 删除 ${x.removedLines}`}>
            <small>{format(trendValue(x))}</small><div className="usage-bar-track"><span style={{height:`${Math.max(trendValue(x)?5:0,Math.round(trendValue(x)/maxCalls*100))}%`}}/></div>
            <span>{x.day.slice(5)}</span>
          </div>)}
        </div>:<Blank>该时间段暂无可用的 MCP 记录。</Blank>}
      </Panel>
      <Panel title="工具调用排行" hint="来自执行开始事件，而不是大模型提供的 usage 报表">
        {totals.topTools.map(t=><div className="list-row" key={t.tool}><span className="round-symbol">&gt;_</span>
          <div className="grow"><strong>{t.tool}</strong><small>已观测到的调用次数</small></div><strong>{format(t.calls)}</strong></div>)}
        {!totals.topTools.length&&<Blank>该时间段尚无工具执行开始事件。</Blank>}
      </Panel>
    </div>
    <Panel title="项目代码产出" hint="按工作区分组；全局 MCP 流量无法可靠归因到各项目"
      extra={<select className="filter" aria-label="筛选代码产出项目" value={selected?selected.id:"all"}
        onChange={e=>setProjectId(e.target.value)}><option value="all">所有工作区</option>
        {totals.projects.map(p=><option value={p.id} key={p.id}>{p.name} · {p.id.slice(0,6)}</option>)}</select>}>
      {totals.projects.length?<div className="table-scroll"><table className="usage-project-table">
        <thead><tr><th>工作区</th><th>审阅</th><th>涉及文件次数</th><th>不同文件（可识别）</th><th>新增</th><th>删除</th><th>其他编辑</th></tr></thead>
        <tbody>{totals.projects.filter(p=>!selected||p.id===selected.id).map(p=><tr key={p.id}>
          <td><strong>{p.name}</strong><small> {p.id.slice(0,6)}</small></td>
          <td>{format(p.reviews)}</td><td>{format(p.fileTouches)}</td><td>≥ {format(p.uniqueFiles)}</td>
          <td>+{format(p.addedLines)}</td><td>−{format(p.removedLines)}</td><td>{format(p.editOperations)}</td>
        </tr>)}</tbody></table></div>:<Blank>此区间没有可识别的项目代码审阅或编辑记录。</Blank>}
      <p className="footnote">同一工作区同一 Git 审阅引用只计一次；未经过 <code>show_changes</code> 的文件写入无法提供可信行数。这里统计的是审阅快照，不是最终合入代码量。</p>
    </Panel>
    <Panel title="模型用量与效率比较" hint="遵循真实证据；不同模型必须使用可比任务和已知模型身份">
      <div className="usage-limit"><strong>ChatGPT 模型输入 / 输出 / 推理 Token：不可观测</strong>
        <p>Synrex 只接收 MCP 工具请求与响应，不能直接看到 ChatGPT 推理上下文、隐藏推理 Token、缓存命中或真实模型身份。上面的 Token 当量只是 MCP HTTP 字节数 ÷ 4 的粗略文本换算，不是模型 Token，也不能用于费用计算或不同模型的效率排名。</p>
        <p>要进行正式模型 A/B 对比，需另行记录已验证的模型身份、同一任务基线、测试通过情况与独立可获得的模型用量数据；无法取得的字段保留为“未知”。</p>
      </div>
      <p className="footnote">小时汇总起点：{time(coverage.trafficPersistedFrom??undefined)}；Git 账本起点：{time(coverage.codePersistedFrom??undefined)}；最早可见 MCP 诊断：{time(coverage.diagnosticFirstAt??undefined)}。{coverage.diagnosticsCapped||coverage.episodesCapped||coverage.codeReviewsCapped?"部分历史查询达到上限，数据可能遗漏。":"旧数据可能因历史轮转或采集启用时间而缺失。"} 小时汇总边界可能有最多约 1 小时误差。统计来自当前 Console 所在节点的可见 MCP 流量与本地代码记录，远端 Worker 独立执行的数据可能缺失；此页面不是计费账本。</p>
    </Panel>
    <details className="usage-legacy"><summary>原有七天离线统计（独立采集）</summary><UsagePage/></details>
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

function LogsPage({windowsAvailable}:{windowsAvailable:boolean}) {
  const [history,setHistory]=useState<HistoryPayload|null>(null);
  const [coreLog,setCoreLog]=useState("");
  const [tunnelLog,setTunnelLog]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try {
      setHistory(await getJson<HistoryPayload>("/console/api/history"));
      if(windowsAvailable){
        const [core,tunnel]=await Promise.all([
          getJson<ServiceLog>("/console/api/windows/log?service=devspace"),
          getJson<ServiceLog>("/console/api/windows/log?service=tunnel"),
        ]);
        setCoreLog(core.log??"");setTunnelLog(tunnel.log??"");
      }
    } catch {setError("日志暂时不可用，请检查 Console 与本机 Control 状态。");}
    finally {setLoading(false);}
  },[windowsAvailable]);
  useEffect(()=>{void load();},[load]);
  return <div className="stack">
    {error&&<div className="error-banner">{error}</div>}
    <Panel title="Synrex 事件历史" hint="来自受限诊断归档，不包含命令正文、Token 或 OAuth 密钥"
      extra={<button className="refresh" disabled={loading} onClick={()=>void load()}>{loading?"刷新中…":"↻ 刷新"}</button>}>
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>事件</th><th>工具 / 阶段</th><th>Request</th><th>结果</th></tr></thead><tbody>
        {(history?.events??[]).slice(0,120).map((event,index)=><tr key={`${event.ts}-${event.event}-${index}`}>
          <td>{time(event.ts)}</td><td><code>{event.event}</code></td><td>{event.tool??event.stage??"—"}</td>
          <td><code>{event.requestId??"—"}</code></td><td>{event.outcome??"—"}</td></tr>)}
      </tbody></table></div>
      {!history?.events.length&&<Blank>暂无归档事件</Blank>}
    </Panel>
    {windowsAvailable&&<div className="columns">
      <Panel title="Synrex Core 服务日志" hint="Windows Control 最近 200 行"><pre className="log-view">{coreLog||"暂无日志"}</pre></Panel>
      <Panel title="Tunnel 服务日志" hint="Windows Control 最近 200 行"><pre className="log-view">{tunnelLog||"暂无日志"}</pre></Panel>
    </div>}
  </div>;
}

function WindowsOperations() {
  const [status,setStatus]=useState<WindowsStatus|null>(null);
  const [loading,setLoading]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{setStatus(await getJson<WindowsStatus>("/console/api/windows/status"));}
    catch{setError("Windows Control 暂不可用。Synrex Core 不会因此停止运行。");}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const settings=status?.management?.settings;
  async function run(label:string,work:()=>Promise<unknown>){
    setMessage("");setError("");
    try{await work();setMessage(`${label} 已提交并收到本机 Control 回执。`);await load();}
    catch{setError(`${label} 失败，请查看 Synrex 日志。`);}
  }
  async function service(target:"devspace"|"tunnel"|"all",action:"start"|"restart"|"stop"){
    if(action!=="start"&&!window.confirm(`确认对 ${target} 执行 ${action}？`))return;
    await run(`${target} ${action}`,()=>postJson("/console/api/windows/service",{target,action}));
  }
  async function saveConnection(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget);
    const body={
      allowed_roots:String(form.get("roots")??"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean),
      local_port:Number(form.get("port")),public_base_url:String(form.get("public")??""),
      tunnel_mode:String(form.get("tunnelMode")??"Remote"),
    };
    await run("连接设置保存",async()=>{
      await postJson("/console/api/windows/config",body);
      if(settings?.auto_start_available)await postJson("/console/api/windows/autostart",{enabled:form.get("autostart")==="on"});
    });
  }
  async function saveSynrex(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget);
    const body={tool_mode:String(form.get("toolMode")??"codex"),review_ui_enabled:form.get("reviewUi")==="on",
      skills_enabled:form.get("skills")==="on",skill_paths:String(form.get("skillPaths")??"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean),
      logging:{level:String(form.get("logLevel")??"info"),format:String(form.get("logFormat")??"pretty"),
        requests:form.get("logRequests")==="on",tool_calls:form.get("logTools")==="on",shell_commands:form.get("logShell")==="on"}};
    await run("Synrex 设置保存",()=>postJson("/console/api/windows/config",body));
  }
  async function saveTunnelToken(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget),token=String(form.get("token")??"").trim();
    if(!token)return;await run("Tunnel Token 更新",()=>postJson("/console/api/windows/tunnel-token",{token}));
    event.currentTarget.reset();
  }
  if(!status&&!error)return <Blank>正在读取 Windows 运维状态…</Blank>;
  return <div className="stack">
    {error&&<div className="error-banner">{error}</div>}{message&&<div className="notice"><strong>{message}</strong></div>}
    <div className="metrics">
      <Metric label="Synrex Core" value={status?.services?.devspace??"未知"} info={status?.runtime?.actual?.version??"版本未知"} symbol="S"/>
      <Metric label="Tunnel" value={status?.services?.tunnel??"未知"} info={status?.tunnel?.diagnostics?.actual_protocol??"协议未知"} symbol="⇄"/>
      <Metric label="Tunnel HA" value={status?.tunnel?.metrics?.ha_connections??"未知"} info="已登记连接" symbol="⌁"/>
      <Metric label="当前 Slot" value={status?.runtime?.active_slot??"未知"} info={status?.runtime?.pointer_mismatch?"旧配置指针仍需迁移":"运行指针一致"} symbol="◇"/>
    </div>
    <div className="columns">
      <Panel title="服务控制" hint="操作仍由 17678 本机 Control 执行，Synrex Console 只做代理和审计入口">
        <div className="ops-actions">
          <div><strong>Synrex Core</strong><span>{status?.services?.devspace??"未知"}</span><button onClick={()=>void service("devspace","restart")}>重启</button><button onClick={()=>void service("devspace","stop")} className="danger-lite">停止</button></div>
          <div><strong>Cloudflare Tunnel</strong><span>{status?.services?.tunnel??"未知"}</span><button onClick={()=>void service("tunnel","restart")}>重启</button><button onClick={()=>void service("tunnel","stop")} className="danger-lite">停止</button></div>
          <div><strong>全部服务</strong><span>受控启动 / 停止</span><button onClick={()=>void service("all","start")}>启动</button><button onClick={()=>void service("all","restart")}>重启</button></div>
        </div>
      </Panel>
      <Panel title="连接与 Tunnel" hint="公网地址、协议和 Tunnel Token 均沿用原 Windows Control 能力">
        <div className="ops-summary">
          <div><span>公网 MCP</span><code>{status?.mcp?.public_base_url??settings?.effective_public_base_url??"—"}</code></div>
          <div><span>本机健康</span><strong>{status?.mcp?.local_health?.ok?"正常":"异常"}</strong></div>
          <div><span>公网健康</span><strong>{status?.mcp?.public_health?.ok?"正常":"异常"}</strong></div>
          <div><span>Tunnel 模式</span><strong>{settings?.tunnel_mode??"—"}</strong></div>
        </div>
        <form className="ops-form compact" onSubmit={saveTunnelToken}><label>Tunnel Token<input name="token" type="password" autoComplete="off" placeholder={settings?.tunnel_token_present?"已配置 · 输入新 Token 可替换":"输入 Token"}/></label><button className="primary" type="submit">保存 Token</button></form>
      </Panel>
    </div>
    {settings&&<Panel title="连接设置" hint="保存后通常需要重启相关服务；旧状态目录与兼容命名不会随品牌修改">
      <form className="ops-form" onSubmit={saveConnection}>
        <label>允许的工作区根目录<textarea name="roots" defaultValue={(settings.allowed_roots??[]).join("\n")}/></label>
        <label>本机 MCP 端口<input name="port" type="number" min="1" max="65535" defaultValue={settings.local_port??17677}/></label>
        <label>公网 Base URL<input name="public" defaultValue={settings.public_base_url??""}/></label>
        <label>Tunnel 模式<select name="tunnelMode" defaultValue={settings.tunnel_mode??"Remote"}><option>Remote</option><option>Quick</option></select></label>
        {settings.auto_start_available&&<label className="check"><input name="autostart" type="checkbox" defaultChecked={Boolean(settings.auto_start)}/> 登录后自动启动</label>}
        <button className="primary" type="submit">保存连接设置</button>
      </form>
    </Panel>}
    {settings&&<Panel title="Synrex 设置" hint="沿用 Windows Control 的配置验证；敏感字段不会回显">
      <form className="ops-form" onSubmit={saveSynrex}>
        <label>工具模式<select name="toolMode" defaultValue={settings.tool_mode??"codex"}><option value="codex">codex</option><option value="claude">claude</option></select></label>
        <label>日志级别<select name="logLevel" defaultValue={settings.logging?.level??"info"}><option>silent</option><option>error</option><option>warn</option><option>info</option><option>debug</option></select></label>
        <label>日志格式<select name="logFormat" defaultValue={settings.logging?.format??"pretty"}><option>pretty</option><option>json</option></select></label>
        <label>额外 Skill 路径<textarea name="skillPaths" defaultValue={(settings.skill_paths??[]).join("\n")}/></label>
        <label className="check"><input name="reviewUi" type="checkbox" defaultChecked={settings.review_ui_enabled!==false}/> Review UI</label>
        <label className="check"><input name="skills" type="checkbox" defaultChecked={settings.skills_enabled!==false}/> Skills</label>
        <label className="check"><input name="logRequests" type="checkbox" defaultChecked={settings.logging?.requests!==false}/> 请求日志</label>
        <label className="check"><input name="logTools" type="checkbox" defaultChecked={settings.logging?.tool_calls!==false}/> 工具日志</label>
        <label className="check"><input name="logShell" type="checkbox" defaultChecked={Boolean(settings.logging?.shell_commands)}/> Shell 命令日志</label>
        <button className="primary" type="submit">保存 Synrex 设置</button>
      </form>
      <div className="ops-inline-actions"><button onClick={()=>void run("配置校验",()=>postJson("/console/api/windows/validate",{}))}>校验配置</button><button onClick={()=>void run("环境诊断",()=>postJson("/console/api/windows/doctor",{}))}>运行 Doctor</button><button disabled={loading} onClick={()=>void load()}>刷新状态</button></div>
    </Panel>}
  </div>;
}
function App() {
  const [auth,setAuth]=useState<boolean|null>(null);
  const [data,setData]=useState<Snapshot|null>(null);
  const [view,setView]=useState<View>("overview");
  const [windowsAvailable,setWindowsAvailable]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [clock,setClock]=useState(Date.now());
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
    if(!auth){setWindowsAvailable(false);return;}
    let live=true;
    getJson<WindowsStatus>("/console/api/windows/status")
      .then(()=>{if(live)setWindowsAvailable(true);})
      .catch(()=>{if(live)setWindowsAvailable(false);});
    return()=>{live=false;};
  },[auth]);
  useEffect(()=>{if(view==="windows"&&!windowsAvailable)setView("overview");},[view,windowsAvailable]);
  useEffect(()=>{if(!auth) return; const timer=window.setInterval(()=>{
    if(!document.hidden)void refresh();
  },10000);return ()=>window.clearInterval(timer);},[auth,refresh]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),5000);
    return ()=>window.clearInterval(timer);},[]);
  useEffect(()=>{
    if(!auth || view!=="correlation")return;
    let live=true;
    async function measureClock(){
      const start=Date.now();
try{
        const x=await getJson<{serverTimeMs:number}>("/console/api/clock");
        const end=Date.now();
        if(live&&Number.isFinite(x.serverTimeMs)){
          setClockOffsetMs((start+end)/2-x.serverTimeMs);
          setClockUncertaintyMs((end-start)/2);
        }
      }catch{if(live){setClockOffsetMs(null);setClockUncertaintyMs(null);}}
    }
    void measureClock();
    const timer=window.setInterval(()=>void measureClock(),10000);
    return()=>{live=false;window.clearInterval(timer);};
  },[auth,view]);
  async function logout(){
    try {await getJson("/console/api/logout",{method:"POST",headers:{"content-type":"application/json"}});}
    finally {setAuth(false);setData(null);}
  }
  if(auth===null) return <main className="boot">正在连接 Synrex…</main>;
  if(!auth) return <Login done={()=>void refresh()}/>;
  const menus=windowsAvailable?[...coreMenus,windowsMenu]:coreMenus;
  const meta=menus.find(x=>x.id===view)??coreMenus[0]!;
  const ageMs=clock-Date.parse(data?.generatedAt??"");
  const stale=Boolean(data?.snapshotStale)||!Number.isFinite(ageMs)||ageMs>45000;
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">S</div>
<div><strong>SYNREX<span>.</span></strong><small>CONTROL PLANE</small></div></div>
    <p className="sidebar-label">WORKSPACE</p><nav aria-label="Synrex 管理导航">
      {menus.map(item=><button key={item.id} className={`nav-item ${view===item.id?"active":""}`}
        onClick={()=>setView(item.id)} aria-current={view===item.id?"page":undefined}>
        <span className="nav-symbol">{item.symbol}</span>{item.title}</button>)}</nav>
    <div className="sidebar-bottom"><div className="owner"><span className="round-symbol">♙</span><div><strong>Owner Access</strong><small>{windowsAvailable?"观测 + Windows 运维":"只读观测"}</small></div></div>
      <button onClick={()=>void logout()}>退出登录 ↗</button></div>
  </aside><main className="main"><header className="topbar"><span>Synrex Console <b>/</b> <strong>{meta.title}</strong></span>
    <div><span className="online-dot"/> {stale?"数据过期":"数据新鲜"} <button className="refresh" disabled={loading} onClick={()=>void refresh()}>{loading?"刷新中…":"↻ 刷新"}</button></div>
  </header><div className="content"><div className="heading"><p className="eyebrow">SYNREX OPERATIONS / {view.toUpperCase()}</p>
    <h1>{view==="overview"?"开发环境，一目了然。":meta.title}</h1>
    <div className="heading-line"><p>{view==="overview"?"主机、执行、工作流与诊断，一站式掌控。":meta.caption+" · 显示已有的真实数据"}</p>
      <span>更新于 {time(data?.generatedAt)} · {Number.isFinite(ageMs)?Math.max(0,Math.round(ageMs/1000))+" 秒前":"时间未知"}</span></div></div>
    {stale&&<div className="error-banner" role="alert">Console 快照已过期。当前为历史数据，不代表实时进程状态；请检查独立快照服务。</div>}
    {error&&<div className="error-banner" role="alert">{error} <button onClick={()=>void refresh()}>重试</button></div>}
    {data?<>{view==="overview"&&<Overview d={data} go={setView}/>}
      {view==="usage"&&<Usage d={data}/>}
      {view==="workflows"&&<Workflows d={data}/>}
      {view==="tasks"&&<Tasks d={data}/>}
      {view==="nodes"&&<Nodes d={data}/>}
      {view==="diagnostics"&&<Diagnostics d={data}/>}
      {view==="correlation"&&<LegacyDiagnostics d={data} clockOffsetMs={clockOffsetMs} clockUncertaintyMs={clockUncertaintyMs}/>}
      {view==="resources"&&<Resources d={data}/>}
      {view==="logs"&&<LogsPage windowsAvailable={windowsAvailable}/>}
      {view==="memory"&&<Memory d={data}/>}
      {view==="windows"&&windowsAvailable&&<WindowsOperations/>}</>:<Blank>暂无系统数据</Blank>}
    <footer className="content-footer">Synrex Console · {data?.service.release??"离线"} <span>{windowsAvailable?"OBSERVE + GUARDED WINDOWS OPS":"READ ONLY"} · GPT IS THE ORCHESTRATOR</span></footer>
  </div></main></div>;
}
const container=document.getElementById("app");
if(container)createRoot(container).render(<App/>);
