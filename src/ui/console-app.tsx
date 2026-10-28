import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { analyzeBrowserTransport } from "../browser-transport-analysis.js";
import { LegacyDiagnostics } from "./console-legacy-diagnostics.js";
import "./console-app.css";

type View = "overview" | "usage" | "workflows" | "tasks" | "nodes" | "diagnostics" | "correlation" | "resources" | "memory";
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
type DelegationMetrics = { window:"24h"; source:{scope:"local_workspace";diagnosticsCapped:boolean;agentRecordsCapped:boolean;
  agentsAvailable:boolean;note:string};
  totals:{observedMcpToolCalls:number;agentSessionsStarted:number;agentTurnsCompleted:number;
    agentTurnsFailed:number;agentExecutionMs:number;agentTurnSuccessPercent:number|null;userTaskSuccessPercent:null};
  workspaces:Array<{workspaceId:string;observedMcpToolCalls:number;agentSessionsStarted:number;
    agentTurnsCompleted:number;agentTurnsFailed:number;agentExecutionMs:number}>;
  agentTasks:Array<{agentId:string;workspaceId:string;provider:string;state:string;
    createdAt:string;finishedTurns:number;failedTurns:number;executionMs:number}> };
type UsageTotals = { requests:number; completed:number; toolExecutions:number; inputBytes:number; outputBytes:number;
  measuredInput:number;measuredOutput:number;
  payloadTokenEquivalentInput:number;payloadTokenEquivalentOutput:number;gitReviews:number;reviewedFileTouches:number;
  distinctReviewedFiles:number;distinctFileCountComplete:boolean;addedLines:number;removedLines:number;otherEditOperations:number;
  projects:Array<{id:string;name:string;reviews:number;fileTouches:number;uniqueFiles:number;addedLines:number;removedLines:number;editOperations:number}>;
  topTools:Array<{tool:string;calls:number}>;
  trends:Array<{day:string;requests:number;toolExecutions:number;addedLines:number;removedLines:number}> };
type Snapshot = {
  generatedAt: string;
  sourceHealth?:{available:boolean;unavailable:string[]};
  dataFreshness?: {sampledAt:string;nodes:string|null;workflows:string|null;tasks:string|null;
    diagnostics:string|null;runtime:string|null};
  snapshotStale?: boolean;
  service: { status: string; release: string };
  nodes: Array<{ id: string; alias: string; kind: string; health: string; os: string; lastSeenAt: string;
    contract: { matching: number; missing: number; incompatible: number; total: number }; version: string | null }>;
  workflows: Array<{ id: string; title: string; goal: string; workspace: string; status: string; revision: number;
    phase: string; summary: string; nextSteps: string[]; blockers: string[]; taskIds: string[]; checks:string[]; acceptanceCriteria:string[]; updatedAt: string }>;
  conversationSessions: Array<{id:string;title:string;lastAt:string;requestCount:number;runningTasks:number;state:string;
    toolCalls?:number;inputTokens?:number|null;outputTokens?:number|null;measuredInputs?:number;measuredOutputs?:number;
    requests:Array<{requestId:string;tool?:string;lastAt:string;taskId?:string;runId?:string;classification:string}>}>;
  delegation?: DelegationMetrics;
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
    capacity?:{inputP95:number|null;outputP95:number|null;largestOutput:number;largeResponses:number;bytesPerSecond:number|null};
    recentTraffic?:{windowSeconds:60;inputBytesPerSecond:number|null;outputBytesPerSecond:number|null;
      measuredResponses:number;lastObservedAt:string|null};
    tokens?:{encoding:string;windowSeconds:number;inputTotal:number|null;outputTotal:number|null;
      measuredInputs:number;measuredOutputs:number;recentOutputTokens?:number|null;recentOutputSamples?:number;
      toolCallsPerMinute:number|null;averageLatencyMs:number|null;lastObservedAt:string|null;
      trend:Array<{minute:string;outputTokens:number;measuredOutputs:number}>;
      history?:{startedAt:string;observedFrom?:string|null;updatedAt:string;coverageGaps:number;
        totals:{inputTokens:number;outputTokens:number;calls:number;measuredInputs:number;measuredOutputs:number};
        peakMinute:{at:string;tokens:number}|null;
        peakOutputCall:{at:string;tokens:number}|null;
        runtime?:{averageTokensPerSecond:number|null;matchedOutputTokens:number;matchedDurationMs:number;
          measuredCalls:number;observedFrom:string|null};
        effective?:{windowSeconds:number;scope:"host_session_associated";outputTokens:number;
          matchedCalls:number;unknownCalls:number;totalMatchedCalls:number;sessionCount:number;
          perSessionActiveMs:number;globalActiveMs:number;maxConcurrency:number;
          perSessionTokensPerSecond:number|null;globalActiveTokensPerSecond:number|null;
          sessions?:Array<{conversationId:string;matchedCalls:number;outputTokens:number;activeMs:number;
            observedSpanMs:number;activeTokensPerSecond:number|null;firstAt:string;lastAt:string}>;
          attributionCoveragePercent:number|null;truncatedCalls?:number;
          status:"observed"|"unavailable";note:string};
        minute:Array<TokenHistoryPoint>;hour:Array<TokenHistoryPoint>;day:Array<TokenHistoryPoint>}|null} };
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
const menus: Array<{ id: View; title: string; symbol: string; caption: string }> = [
  { id: "overview", title: "总览", symbol: "▦", caption: "系统状态" },
  { id: "usage", title: "用量与产出", symbol: "▤", caption: "MCP 用量与 Git 产出" },
  { id: "workflows", title: "工作流", symbol: "☷", caption: "任务与检查点" },
  { id: "tasks", title: "执行索引", symbol: ">_", caption: "持久任务位置" },
  { id: "nodes", title: "主机节点", symbol: "⌘", caption: "版本与契约" },
  { id: "diagnostics", title: "诊断中心", symbol: "⌁", caption: "MCP 时间线" },
  { id: "correlation", title: "关联排障", symbol: "⌁", caption: "浏览器与 MCP 因果关系" },
  { id: "resources", title: "资源与网络", symbol: "▥", caption: "进程 / CPU / 网络" },
  { id: "memory", title: "记忆与治理", symbol: "◇", caption: "学习证据" },
];
type TokenHistoryPoint={at:string;inputTokens:number;outputTokens:number;calls:number;
  measuredInputs:number;measuredOutputs:number;runtimeMatchedTokens?:number;runtimeDurationMs?:number;
  runtimeSamples?:number;runtimeAverageTokensPerSecond?:number|null};
const statusText: Record<string,string> = {
  online:"在线", offline:"离线", suspect:"连接异常", draining:"停止调度", active:"进行中",
  blocked:"阻塞", completed:"已完成", cancelled:"已取消",
  rev_http_completed:"Synrex 已返回", connection_closed_early:"连接提前断开",
  tool_completed_connection_closed:"工具已结束 / 连接提前断开",
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
    : ["offline","blocked","connection_closed_early","tool_completed_connection_closed","rev_handler_error"].includes(value) ? "bad" : "pending";
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
function RexPerformance({d}:{d:Snapshot}) {
  const t=d.diagnostics.observability?.tokens;
  const history=t?.history;
  const effective=history?.effective;
  const [range,setRange]=useState<"24h"|"30d"|"365d">("24h");
  const [curve,setCurve]=useState<"volume"|"active">("volume");
  const total=history?history.totals.inputTokens+history.totals.outputTokens:t&&(t.inputTotal!==null||t.outputTotal!==null)
    ?(t.inputTotal??0)+(t.outputTotal??0):null;
  const trend=history?(range==="24h"?history.minute:range==="30d"?history.hour:history.day):[];
  const hasTrend=trend.some(b=>curve==="volume"?b.measuredOutputs>0:(b.runtimeSamples??0)>0);
  const plot=trend.filter(b=>curve==="volume"?b.measuredOutputs>0:(b.runtimeSamples??0)>0);
  const maximum=Math.max(1,...plot.map(b=>curve==="volume"?b.outputTokens:(b.runtimeAverageTokensPerSecond??0)));
  const first=trend.length?Date.parse(trend[0]!.at):0;
  const last=trend.length?Date.parse(trend[trend.length-1]!.at):0;
  const points=plot.map((b,i)=>`${last>first?600*(Date.parse(b.at)-first)/(last-first):300},${110-100*(curve==="volume"?b.outputTokens:(b.runtimeAverageTokensPerSecond??0))/maximum}`).join(" ");
  const windowRuntimeTokens=trend.reduce((n,b)=>n+(b.runtimeMatchedTokens??0),0);
  const windowRuntimeMs=trend.reduce((n,b)=>n+(b.runtimeDurationMs??0),0);
  const windowRuntimeCalls=trend.reduce((n,b)=>n+(b.runtimeSamples??0),0);
  const windowRuntimeRate=windowRuntimeMs>0?Math.round(windowRuntimeTokens*10000/windowRuntimeMs)/10:null;
  return <Panel title="Rex Performance" hint="主机会话关联与 Subagent 独立统计 · 不是 GPT 模型的解码速度">
    <div className="metrics performance-metrics">
      <Metric label="可关联会话" symbol="⇄" value={effective?.sessionCount??"未测量"}
        info={`最近 24h · ${effective?.matchedCalls??0} 次完整工具请求，按对话独立统计`}/>
      <Metric label="最大观测并发" symbol="↑" value={effective?.matchedCalls?`${effective.maxConcurrency} 次`:"未测量"}
        info="不同对话可以并发；不作为模型生成速度"/>
      <Metric label="会话 ID 关联率" symbol="⊙" value={effective?.attributionCoveragePercent==null?"未测量":`${effective.attributionCoveragePercent}%`}
        info={`只是已配对请求的会话 ID 覆盖，不是 Token 或主 GPT 身份覆盖；未知 ${effective?.unknownCalls??0}`}/>
      <Metric label="端到端 / GPT 纯思考时间" symbol="◴" value="未测量"
        info="主机尚无可靠回合边界；不得把工具间隔当成纯思考"/>
      <Metric label={history?"已计量工具 Token 累计":"当前窗口工具 Token"} symbol="▤" value={total===null?"未测量":total.toLocaleString("zh-CN")}
        info={history?`自 ${time(history.observedFrom??history.startedAt)} 的已计量样本累计；输入 ${history.totals.measuredInputs} / 输出 ${history.totals.measuredOutputs} 次。会持续累加，不是上下文长度或计费 Token。`:"仅展示当前诊断窗口的工具内容计量"}/>
      <Metric label="工具调用速率" symbol="⌘" value={t?.toolCallsPerMinute==null?"未知":`${t.toolCallsPerMinute} 次/min`}
        info="最近 60 秒观察到的工具启动"/>
      <Metric label="平均调用延迟" symbol="◷" value={t?.averageLatencyMs==null?"未测量":`${t.averageLatencyMs} ms`}
        info="最近 60 秒有完整记录的调用"/>
    </div>
    <div className="performance-chart">
      <p className="footnote">分对话工具交付 · 最近 24 小时（仅有会话 ID 的完整样本）</p>
      {effective?.sessions?.length?<div className="table-scroll"><table>
        <thead><tr><th>会话标识</th><th>调用</th><th>输出 Token</th><th>工具活跃时间</th><th>按活跃耗时折算</th><th>最后活动</th></tr></thead>
        <tbody>{effective.sessions.map(s=><tr key={s.conversationId}>
          <td title={s.conversationId}>{s.conversationId.slice(0,13)}…</td>
          <td>{s.matchedCalls}</td><td>{s.outputTokens.toLocaleString("zh-CN")}</td>
          <td>{(s.activeMs/1000).toFixed(2)} s</td>
          <td>{s.activeTokensPerSecond==null?"未测量":`${s.activeTokensPerSecond} Token/活跃秒`}</td>
          <td>{time(s.lastAt)}</td>
        </tr>)}</tbody>
      </table></div>:<Blank>当前没有完整且有会话标识的工具请求。</Blank>}
      <p className="footnote">每条会话各自合并并发请求区间；“Token/活跃秒”只是工具请求输出量 ÷ 已观测调用活跃时间，不是按秒采样，更不是模型生成速度。</p>
    </div>
    <div className="performance-chart">
      <div className="usage-actions"><p className="footnote">旧全来源历史账本（不按会话归属过滤）</p>
        <div className="usage-range" role="group" aria-label="Token 历史范围">
          {(["24h","30d","365d"] as const).map(v=><button key={v} type="button" className={range===v?"selected":""}
            aria-pressed={range===v} onClick={()=>setRange(v)}>{v==="24h"?"24 小时":v==="30d"?"30 天":"365 天"}</button>)}
        </div></div>
      <div className="usage-range" role="group" aria-label="Token 趋势指标">
        <button type="button" className={curve==="volume"?"selected":""} aria-pressed={curve==="volume"} onClick={()=>setCurve("volume")}>输出 Token</button>
        <button type="button" className={curve==="active"?"selected":""} aria-pressed={curve==="active"} onClick={()=>setCurve("active")}>调用耗时折算</button>
      </div>
      {hasTrend?<svg role="img" aria-label={`${range} ${curve==="volume"?"输出 Token":"调用耗时加权吞吐"}历史趋势`}
        viewBox="0 0 600 120" preserveAspectRatio="none" style={{width:"100%",height:125}}>
        <line x1="0" y1="110" x2="600" y2="110" stroke="currentColor" opacity="0.2"/>
        {plot.length===1?<circle cx="300" cy={110-100*(curve==="volume"?plot[0]!.outputTokens:(plot[0]!.runtimeAverageTokensPerSecond??0))/maximum} r="4" fill="currentColor"/>:
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>}
      </svg>:<Blank>该时间范围暂无相关完整观测样本。</Blank>}
      <p className="footnote">最近 60 秒记录到的工具输出：{t?.recentOutputTokens==null?"未测量":`${t.recentOutputTokens.toLocaleString("zh-CN")} Token（${t.recentOutputSamples??0} 个已计量输出）`}。历史完成调用折算：{history?.runtime?.averageTokensPerSecond==null?"未测量":`${history.runtime.averageTokensPerSecond} Token/调用秒`}；所选时段：{windowRuntimeRate===null?"未测量":`${windowRuntimeRate} Token/调用秒`}（{windowRuntimeCalls} 次）。后二者是输出量 ÷ 请求耗时，不是逐秒生成速率。</p>
      <div className="metrics performance-peaks">
        <Metric symbol="⌁" label="单分钟记录输出峰值" value={history?.peakMinute?`${history.peakMinute.tokens.toLocaleString("zh-CN")} Token`:"未测量"}
          info={history?.peakMinute?`该分钟桶内记录的输出总量 · ${time(history.peakMinute.at)}`:"不除以 60，不冒充逐秒生成速度"}/>
        <Metric symbol="↑" label="最大单次工具输出" value={history?.peakOutputCall?`${history.peakOutputCall.tokens.toLocaleString("zh-CN")} Token`:"未测量"}
          info={history?.peakOutputCall?time(history.peakOutputCall.at):"仅计量文本结果"}/>
      </div>
      <p className="footnote">编码器 {t?.encoding??"尚未接入"}；会话关联吞吐仅基于新版本可配对的 MCP 调用（滚动 24h），Subagent 的独立 Provider 用量不混入这一分子。未知来源仍保留在旧总体账本。{history?.coverageGaps?`检测到 ${history.coverageGaps} 次日志缺口。`:"日志缺口 0 不代表覆盖率 100%。"}独立采集器增量记录，无模型调用。</p>
    </div>
  </Panel>;
}
function SessionTokenUsage({d}:{d:Snapshot}) {
  return <Panel title="会话 Token 与调用量" hint="只按有明确 conversationId 的 MCP 请求归类；累计范围限于当前诊断窗口">
    {d.conversationSessions.length?<div className="table-scroll"><table>
      <thead><tr><th>会话</th><th>工具调用</th><th>输入 Token</th><th>输出 Token</th><th>计量覆盖</th><th>最近活动</th></tr></thead>
      <tbody>{d.conversationSessions.slice(0,20).map(s=><tr key={s.id}>
        <td title={s.id}>{s.title===s.id?s.id.slice(0,16)+"…":s.title}</td>
        <td>{s.toolCalls??"未知"}</td>
        <td>{s.inputTokens==null?"未测量":s.inputTokens.toLocaleString("zh-CN")}</td>
        <td>{s.outputTokens==null?"未测量":s.outputTokens.toLocaleString("zh-CN")}</td>
        <td>{s.measuredInputs??0} / {s.measuredOutputs??0} 次输入/输出</td>
        <td>{time(s.lastAt)}</td>
      </tr>)}</tbody>
    </table></div>:<Blank>暂无可明确关联到会话的请求；不按时间猜测会话归属。</Blank>}
    <p className="footnote">上述为 o200k_base 工具内容 Token；不包含 GPT 的隐藏上下文、推理 Token，也不保证覆盖已滚动清理的日志。</p>
  </Panel>;
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
    <RexPerformance d={d}/>
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
    {d.delegation&&<Panel title="GPT / Subagent 委派效率" hint="近 24 小时 · 本机工作区 · 历史记录只读聚合">
      <div className="metrics">
        <Metric label="MCP 工具调用" value={d.delegation.totals.observedMcpToolCalls}
          info="服务端观测调用，不等于 GPT 内部推理" symbol="⌘"/>
        <Metric label="新建 Subagent" value={d.delegation.totals.agentSessionsStarted}
          info="会话数；继续会话不会重复计数" symbol="◇"/>
        <Metric label="Agent 执行时长" value={Math.round(d.delegation.totals.agentExecutionMs/1000)+" s"}
          info="已记录终态 Agent 回合之和" symbol="◷"/>
        <Metric label="Agent 回合成功率" value={d.delegation.totals.agentTurnSuccessPercent===null
          ?"无样本":d.delegation.totals.agentTurnSuccessPercent+"%"}
          info="非用户任务完成率" symbol="✓"/>
      </div>
      <p className="footnote">{d.delegation.source.note}</p>
      {(d.delegation.source.diagnosticsCapped||d.delegation.source.agentRecordsCapped)&&
        <p className="footnote">部分历史日志已达到读取上限，当前指标只表示已观测样本，不代表完整周期总量。</p>}
      {!d.delegation.source.agentsAvailable&&<p className="footnote">本地 Agent 记录暂不可用，委派数据不能视为零使用量。</p>}
      <div className="table-scroll"><table><thead><tr>
        <th>工作区</th><th>MCP 工具调用</th><th>Subagent 新会话</th><th>Agent 回合成功 / 失败</th><th>Agent 时长</th>
      </tr></thead><tbody>
        {d.delegation.workspaces.map(w=><tr key={w.workspaceId}>
          <td><code title={w.workspaceId}>{w.workspaceId}</code></td>
          <td>{w.observedMcpToolCalls}</td><td>{w.agentSessionsStarted}</td>
          <td>{w.agentTurnsCompleted} / {w.agentTurnsFailed}</td>
          <td>{Math.round(w.agentExecutionMs/1000)} s</td>
        </tr>)}
      </tbody></table></div>
      {d.delegation.agentTasks.length>0&&<>
        <p className="footnote">最近 Agent 任务（Agent ID 是独立执行标识，并非 GPT 用户任务 ID）</p>
        <div className="table-scroll"><table><thead><tr>
          <th>Agent ID</th><th>Provider</th><th>状态</th><th>回合成功 / 失败</th><th>耗时</th>
        </tr></thead><tbody>
          {d.delegation.agentTasks.slice(0,10).map(a=><tr key={a.agentId}>
            <td><code>{a.agentId}</code></td><td>{a.provider}</td><td>{a.state}</td>
            <td>{a.finishedTurns-a.failedTurns} / {a.failedTurns}</td><td>{Math.round(a.executionMs/1000)} s</td>
          </tr>)}
        </tbody></table></div>
      </>}
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
  const localNode=d.nodes.find(n=>n.kind==="local");
  const localNodeLabel=localNode?.alias||localNode?.id||"本机";
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
    if(/\.zip$/i.test(file.name)){
      setBrowserError("这是扩展安装 ZIP，不是观测数据。请先解压并在 chrome://extensions 中“加载已解压的扩展”；随后从扩展弹窗导出 JSON，再在这里导入。");return;
    }
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
          <td>{e.nodeId??localNodeLabel}</td><td>{e.conversationTitle??"未知"}</td><td>{e.requestId??e.nodeRequestId??"—"}</td></tr>)}</tbody></table></div>
      {!history.length&&<Blank>点击“检索”可查询历史事件；未执行检索不代表没有日志。</Blank>}
    </Panel>
    <Panel title="浏览器扩展与消息流元数据" hint="扩展 ZIP 用于安装；扩展导出的 JSON 才用于这里导入">
      <a href="/console/api/browser-extension" download="synrex-browser-observer.zip">
        ① 下载当前 Synrex 浏览器观测扩展 ZIP
      </a>
      <p className="footnote">② 解压 ZIP → 打开 <code>chrome://extensions</code> → 开启“开发者模式” → “加载已解压的扩展” → 选择解压后的目录。Chrome 不能直接把 ZIP 通过下面的文件框安装。</p>
      <p className="footnote">③ 切到 ChatGPT 标签页，打开扩展并运行“测试实际页面网络采集”；通过后点击“导出 JSON（手动导入 Console）”。</p>
      <label>④ 导入扩展导出的 <code>synrex-browser-metadata.json</code>：
      <input type="file" accept=".json,application/json" onChange={e=>{
const file=e.currentTarget.files?.[0];if(file)void loadBrowserMetadata(file);
      }}/></label>
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
  const localNode=d.nodes.find(n=>n.kind==="local");
  const localNodeId=localNode?.id??"local";
  const localNodeLabel=localNode?.alias||localNode?.id||"本机";
  const selectableNodes=useMemo(()=>{
    const seen=new Map<string,string>();
    seen.set(localNodeId,localNodeLabel);
    for(const node of d.nodes)seen.set(node.id,node.alias||node.id);
    for(const event of d.diagnostics.events)if(event.nodeId&&!seen.has(event.nodeId))seen.set(event.nodeId,event.nodeId);
    return [...seen.entries()];
  },[d.nodes,d.diagnostics.events,localNodeId,localNodeLabel]);
  const [host,setHost]=useState(localNodeId);
  useEffect(()=>{if(!selectableNodes.some(([id])=>id===host))setHost(localNodeId);},[host,localNodeId,selectableNodes]);
  const isLocal=host===localNodeId;
  const runtime=d.observability.runtime;
  const eventNode=(nodeId?:string)=>nodeId??localNodeId;
  const latestNodeNetwork=d.diagnostics.events.find(e=>e.event==="network_sampled"&&eventNode(e.nodeId)===host);
  const networkStatus=latestNodeNetwork??(isLocal?d.observability.network:{});
  const mib=(bytes?:number)=>bytes===undefined?"未知":(bytes/1048576).toFixed(1)+" MiB";
  const runtimeSamples=d.diagnostics.events.filter(e=>e.event==="runtime_sampled"&&typeof e.rssBytes==="number"&&
    eventNode(e.nodeId)===host);
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
  const traffic=d.diagnostics.observability?.recentTraffic;
  const transferRate=(n:number|null|undefined)=>n==null?"未知":n>=1048576
    ?(n/1048576).toFixed(2)+" MiB/s":n>=1024?(n/1024).toFixed(1)+" KiB/s":n+" B/s";
const tunnelFailures=d.diagnostics.events.filter(e=>e.event==="tunnel_auth_failed"||e.event==="tunnel_disconnected");
  return <div className="stack">
    <div className="notice"><strong>采集范围：可控主机与进程</strong><p>
Collector：{d.observability.collector==="bounded_tail"?"本地归档可读取（仅尾部窗口）":"尚无本地归档数据"}。
      gateway 元数据：{d.observability.peerSync.gateway==="current"?"最近同步":d.observability.peerSync.gateway==="stale"?"已过期":"尚无同步"}。
      网络计数器不能替代单次 MCP 请求 RTT；缺失数据显示“未知”。</p></div>
    <Panel title="实际观测的 MCP 流量速率" hint="最近 60 秒 HTTP 请求/响应正文的字节数 ÷ 60 秒，不是模型 Token/s，也不是物理网卡带宽">
      <div className="metrics">
        <Metric symbol="↓" label="请求输入速率" value={transferRate(traffic?.inputBytesPerSecond)} info="本机已观测请求正文"/>
        <Metric symbol="↑" label="响应输出速率" value={transferRate(traffic?.outputBytesPerSecond)} info="本机已观测响应正文"/>
        <Metric symbol="⌁" label="有字节记录的响应" value={traffic?.measuredResponses??"未知"} info="最近 60 秒样本数"/>
        <Metric symbol="◷" label="流量观测时间" value={time(traffic?.lastObservedAt??undefined)} info="源已停止上报时速率显示未知"/>
      </div>
      <p className="footnote">该速率为服务端实际记录到的 MCP HTTP 有效载荷平均吞吐，不包含 TCP/TLS 开销。不能推导 GPT 每秒生成 Token 或 GPU 生成速度。空闲期间的 0 B/s 仅表示观测窗口内无对应字节；来源过期时不填零。</p>
    </Panel>
    <label>节点 <select className="filter" value={host} onChange={e=>setHost(e.target.value)}>
      {selectableNodes.map(([id,label])=><option key={id} value={id}>{label}{id===localNodeId?"（当前 Server）":""}</option>)}
    </select></label>
    <div className="metrics">
      <Metric symbol="▥" label="Synrex RSS" value={isLocal?mib(runtime.rssBytes):"未知"} info={isLocal?time(runtime.at):"该节点未提供本进程埋点"}/>
      <Metric symbol="▦" label="JS Heap" value={isLocal?mib(runtime.heapUsedBytes):"未知"} info={selectableNodes.find(([id])=>id===host)?.[1]??host}/>
      <Metric symbol="◷" label="事件循环采样延迟" value={isLocal&&runtime.eventLoopLagMs!==undefined?runtime.eventLoopLagMs+" ms":"未知"} info="10 秒采样偏移"/>
      <Metric symbol="⌁" label="正在执行工具" value={isLocal?runtime.activeToolCount??"未知":"未知"} info="采样时刻的活动数量"/>
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
      <Metric symbol="⌁" label="TCP 已采样连接" value={networkStatus.tcpConnections??"未知"} info={time(latestNodeNetwork?.ts??(isLocal?d.observability.network.at:undefined))}/>
      <Metric symbol="▥" label="重传连接数" value={networkStatus.tcpRetransSockets??"未知"} info="采样窗口"/>
      <Metric symbol="◷" label="GC 耗时" value={isLocal&&runtime.gcDurationMs!==undefined?runtime.gcDurationMs+" ms":"未知"} info="最近 10 秒采样区间"/>
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
    <SessionTokenUsage d={d}/>
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
function App() {
  const [auth,setAuth]=useState<boolean|null>(null);
  const [data,setData]=useState<Snapshot|null>(null);
  const [view,setView]=useState<View>("overview");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [clock,setClock]=useState(Date.now());
  const [clockOffsetMs,setClockOffsetMs]=useState<number|null>(null);
  const [clockUncertaintyMs,setClockUncertaintyMs]=useState<number|null>(null);
  const inflight=useRef<AbortController|null>(null);
  const refresh=useCallback(async(force=false)=>{
    if(inflight.current){
      if(!force)return; // Auto-refresh never creates concurrent pending requests.
      inflight.current.abort(); // Manual retry supersedes a stalled request.
    }
    const controller=new AbortController();
    inflight.current=controller;
    const timeout=window.setTimeout(()=>controller.abort(),8000);
    setLoading(true);
    try { const response=await getJson<Snapshot>("/console/api/snapshot",{signal:controller.signal});
      if(inflight.current===controller){setData(response);setAuth(true);setError("");} }
    catch(e) { if(inflight.current===controller){
      if(e instanceof Error&&e.message==="AUTH_REQUIRED")setAuth(false);
      else {setAuth(true);setError(controller.signal.aborted
        ?"快照请求超时（8 秒），仍显示上次成功的数据。":"快照服务暂不可用，仍显示上次成功的数据。");}
    }}
    finally {window.clearTimeout(timeout);if(inflight.current===controller){inflight.current=null;setLoading(false);}}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(!auth) return; const timer=window.setInterval(()=>{
    if(!document.hidden)void refresh();
  },10000);
    const onVisible=()=>{if(!document.hidden)void refresh(true);};
    document.addEventListener("visibilitychange",onVisible);
    return ()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",onVisible);};
  },[auth,refresh]);
  useEffect(()=>()=>{inflight.current?.abort();inflight.current=null;},[]);
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
  const meta=menus.find(x=>x.id===view)!;
  const ageMs=clock-Date.parse(data?.generatedAt??"");
  const stale=!data||Boolean(data.snapshotStale)||data.sourceHealth?.available===false||!Number.isFinite(ageMs)||ageMs>45000||Boolean(error);
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">S</div>
<div><strong>SYNREX<span>.</span></strong><small>CONTROL PLANE</small></div></div>
    <p className="sidebar-label">WORKSPACE</p><nav aria-label="Synrex 管理导航">
      {menus.map(item=><button key={item.id} className={`nav-item ${view===item.id?"active":""}`}
        onClick={()=>setView(item.id)} aria-current={view===item.id?"page":undefined}>
        <span className="nav-symbol">{item.symbol}</span>{item.title}</button>)}</nav>
    <div className="sidebar-bottom"><div className="owner"><span className="round-symbol">♙</span><div><strong>Owner Access</strong><small>只读控制台</small></div></div>
      <button onClick={()=>void logout()}>退出登录 ↗</button></div>
  </aside><main className="main"><header className="topbar"><span>Synrex Console <b>/</b> <strong>{meta.title}</strong></span>
    <div><span className={`online-dot ${stale?"offline-dot":""}`}/> {stale?"数据不可确认":"快照正常"} <button className="refresh" onClick={()=>void refresh(true)}>{loading?"↻ 重新请求":"↻ 刷新"}</button></div>
  </header><div className="content"><div className="heading"><p className="eyebrow">SYNREX OPERATIONS / {view.toUpperCase()}</p>
    <h1>{view==="overview"?"开发环境，一目了然。":meta.title}</h1>
    <div className="heading-line"><p>{view==="overview"?"主机、执行、工作流与诊断，一站式掌控。":meta.caption+" · 显示已有的真实数据"}</p>
      <span>更新于 {time(data?.generatedAt)} · {Number.isFinite(ageMs)?Math.max(0,Math.round(ageMs/1000))+" 秒前":"时间未知"}</span></div></div>
    {stale&&<div className="error-banner" role="alert">Console 数据不可确认：当前为历史数据或采集失败，不代表实时进程状态。请检查独立快照服务。</div>}
    {data?.sourceHealth?.available===false&&<div className="error-banner" role="alert">
      以下数据源未能读取，受影响的空列表和 0 不代表实际为零：{data.sourceHealth.unavailable.join("、")}。
    </div>}
    {error&&<div className="error-banner" role="alert">{error} <button onClick={()=>void refresh(true)}>重试</button></div>}
    {data?<>{view==="overview"&&<Overview d={data} go={setView}/>}
      {view==="usage"&&<Usage d={data}/>}
      {view==="workflows"&&<Workflows d={data}/>}
      {view==="tasks"&&<Tasks d={data}/>}
      {view==="nodes"&&<Nodes d={data}/>}
      {view==="diagnostics"&&<Diagnostics d={data}/>}
      {view==="correlation"&&<LegacyDiagnostics d={data} clockOffsetMs={clockOffsetMs} clockUncertaintyMs={clockUncertaintyMs}/>}
      {view==="resources"&&<Resources d={data}/>}
      {view==="memory"&&<Memory d={data}/>}</>:<Blank>暂无系统数据</Blank>}
    <footer className="content-footer">Synrex Console · {data?.service.release??"离线"} <span>READ ONLY · GPT IS THE ORCHESTRATOR</span></footer>
  </div></main></div>;
}
const container=document.getElementById("app");
if(container)createRoot(container).render(<App/>);
