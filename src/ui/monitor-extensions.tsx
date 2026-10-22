import { useEffect, useState } from "react";
import type { Resources, Statistics, MonitorSnapshot } from "../console-monitor/types.js";
import type { TraceView } from "../console-monitor/trace-view.js";
import "./monitor-extensions.css";

const time = (n: number | null) => n === null ? "未观测" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
const size = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const read = async <T,>(path: string, signal: AbortSignal): Promise<T> => {
  const res = await fetch(`/console/api/${path}`, { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

export function TraceExplorer({ request }: { request: string }) {
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!request) { setTrace(null); setError(""); return; }
    const abort = new AbortController();
    void read<TraceView>(`trace/${encodeURIComponent(request)}`, abort.signal)
      .then(v => { setTrace(v); setError(""); })
      .catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [request]);
  if (!request) return <section className="panel extension"><header><div><h2>Trace 瀑布图</h2><p>在下方日志中选择 Request ID 查看已有阶段；不采集 GPT 内部数据</p></div></header></section>;
  const extent = Math.max(1, trace?.totalMs ?? 0, ...(trace?.spans.map(s => s.offsetMs + s.durationMs) ?? []));
  return <section className="panel extension" aria-label="请求时间轴"><header><div><h2>Trace · {request}</h2><p>{trace?.traceId ?? "无 Trace ID"} · {trace?.status ?? "未确认"} · 已记录 {trace?.events ?? 0} 个事件 · 总耗时 {time(trace?.totalMs ?? null)}</p></div></header>
    {error && <p className="error">{error}</p>}
    {trace && <div className="trace-layout">{trace.spans.map((s, i) => <div className="trace-row" key={`${s.name}-${s.startedAt}-${i}`}>
      <div><strong>{s.name}</strong><small>{s.node ?? "节点未知"} · {time(s.durationMs)} · {s.outcome}</small></div>
      <div className="trace-track" title={`${s.name}: +${time(s.offsetMs)}, ${time(s.durationMs)}`}><span className={s.outcome === "error" ? "trace-error" : ""} style={{left:`${100 * s.offsetMs / extent}%`,width:`${Math.max(.7,100 * s.durationMs / extent)}%`}}/></div>
    </div>)}{!trace.spans.length && <p className="muted">该请求没有可绘制的 stage_finished 事件。不要把缺失阶段当作零耗时。</p>}<p className="muted">{trace.coverage}</p></div>}
  </section>;
}

function ResourceCard({ id, data }: { id: string; data: Resources }) {
  return <div className="peer-metrics"><div><span>CPU</span><strong>{data.cpuPercent === null ? "—" : `${data.cpuPercent.toFixed(1)}%`}</strong></div>
    <div><span>内存</span><strong>{size(data.usedMemory)} / {size(data.totalMemory)}</strong></div>
    <div><span>GPU</span><strong>{data.gpu?.length ? `${data.gpu[0].utilization}%` : "未采集"}</strong></div>
    <div><span>当前用户进程</span><strong>{data.processes.length}{data.processLimitReached ? "+" : ""}</strong></div>
    <small>{id} · {data.hostname} · 观测于 {new Date(data.sampledAt).toLocaleTimeString("zh-CN",{hour12:false})}</small></div>;
}

export function RemoteNodes({ data, processes = false }: { data: MonitorSnapshot; processes?: boolean }) {
  const [node, setNode] = useState("");
  const choices = Object.entries(data.remote ?? {});
  useEffect(() => { if (choices.length && !choices.some(([id]) => id === node)) setNode(choices[0][0]); }, [data.remote, node]);
  if (!choices.length) return <section className="panel extension"><header><div><h2>远端资源</h2><p>尚未配置可信 SSH 只读采集；节点目录状态不代表资源指标</p></div></header></section>;
  const selected = data.remote[node] ?? choices[0][1];
  const stale = !selected.sampledAt || Date.now() - Date.parse(selected.sampledAt) > 45_000;
  return <section className="panel extension"><header><div><h2>{processes ? "远端进程" : "远端节点资源"}</h2><p>通过已认证 SSH 只读采样；断连后不展示旧数据为实时</p></div><select aria-label="远端节点" value={node} onChange={e=>setNode(e.target.value)}>{choices.map(([id])=><option key={id} value={id}>{id}</option>)}</select></header>
    {stale || !selected.resources ? <p className="notice">{selected.error ?? "节点数据过期或暂不可用"}</p> : <><ResourceCard id={node} data={selected.resources}/>{processes && <div className="scroll"><table><thead><tr><th>PID / PPID</th><th>进程</th><th>状态</th><th>内存</th></tr></thead><tbody>{selected.resources.processes.map(p=><tr key={p.pid}><td>{p.pid} / {p.ppid}</td><td>{p.name}</td><td>{p.state}</td><td>{size(p.rssBytes)}</td></tr>)}</tbody></table></div>}</>}
  </section>;
}

export function StatisticsBreakdown({ tick }: { tick: string }) {
  const [minutes, setMinutes] = useState(1440);
  const [stats, setStats] = useState<Statistics | null>(null);
  useEffect(() => { const abort = new AbortController(); void read<Statistics>(`statistics?minutes=${minutes}`, abort.signal).then(setStats).catch(()=>{}); return () => abort.abort(); }, [minutes,tick]);
  return <section className="panel extension"><header><div><h2>节点与阶段对比</h2><p>仅统计已观测的阶段事件。节点次数不等于请求总量。</p></div><select aria-label="节点对比时间窗" value={minutes} onChange={e=>setMinutes(Number(e.target.value))}><option value={60}>最近一小时</option><option value={1440}>最近一天</option><option value={10080}>最近七天</option></select></header>
    <div className="scroll"><table><thead><tr><th>节点</th><th>阶段样本</th><th>错误</th><th>P50</th><th>P95</th></tr></thead><tbody>{(stats?.nodes??[]).map(n=><tr key={n.name}><td>{n.name}</td><td>{n.count}</td><td>{n.errors}</td><td>{time(n.p50)}</td><td>{time(n.p95)}</td></tr>)}</tbody></table></div>
    {!stats?.nodes.length && <p className="muted">当前窗口没有带节点标识的阶段样本。</p>}
    {stats && <p className="muted">分钟聚合请求量 {stats.requests.count}；保留的原始延迟样本 {stats.requests.latencyCount}。原始事件可能因轮转缺失。</p>}
  </section>;
}
