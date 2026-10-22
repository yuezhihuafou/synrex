import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { readConsoleSnapshot } from "../console-snapshot.js";
import { ExecutionReader, RUN_LIMIT, LOG_LIMIT } from "./executions.js";
import { ResourceSampler, PROCESS_LIMIT } from "./resources.js";
import { StatisticsStore, HISTORY_LIMIT, RETENTION_DAYS } from "./statistics.js";
import { PeerSampler } from "./peers.js";
import type { MonitorSnapshot } from "./types.js";

export interface CollectorOptions {
  stateDir: string;
  runRoot: string;
  database: string;
  writableRoots?: string[];
  release?: string;
  intervalMs?: number;
  peerSsh?: Record<string, string>;
}

export class MonitorCollector extends EventEmitter {
  readonly runs: ExecutionReader;
  readonly stats: StatisticsStore;
  private readonly resources = new ResourceSampler();
  private readonly peers: PeerSampler;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private baseAt = 0;
  private subscribers = 0;
  private inFlight: Promise<void> | null = null;
  snapshot: MonitorSnapshot;
  constructor(readonly options: CollectorOptions) {
    super();
    this.runs = new ExecutionReader(options.runRoot, options.writableRoots);
    this.peers = new PeerSampler(options.peerSsh ?? {});
    this.stats = new StatisticsStore(options.database);
    this.snapshot = { generatedAt: new Date().toISOString(), sampledAt: "", sampleMs: 0,
      source: { node: hostname(), release: options.release ?? "independent-monitor", scope: options.peerSsh && Object.keys(options.peerSsh).length ? "本机任务与资源；指定远端经 SSH 只读采样" : "本机进程与运行记录；远端节点仅显示目录状态", management: options.writableRoots?.length ? "指定工作区可取消任务" : "只读监控" },
      resources: null, remote: {}, executions: [], base: null, warnings: [],
      limits: { runs: RUN_LIMIT, processes: PROCESS_LIMIT, logBytes: LOG_LIMIT, events: HISTORY_LIMIT, retentionDays: RETENTION_DAYS } };
  }
  start() { this.stopped = false; this.schedule(0); }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.sample().finally(() => { this.inFlight = null; this.schedule(this.subscribers ? Math.max(2000, this.options.intervalMs ?? 5000) : 30_000); });
    }, delay);
    this.timer.unref();
  }
  subscribe() {
    this.subscribers++;
    if (!this.busy) { if (this.timer) clearTimeout(this.timer); this.schedule(0); }
    return () => { this.subscribers = Math.max(0, this.subscribers - 1); };
  }
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.inFlight; this.stats.close(); }

  async sample() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const started = Date.now(), warnings: string[] = [];
    try {
      try {
        await this.stats.collectDiagnostics(this.options.stateDir);
      } catch { warnings.push("诊断采集暂不可用；统计显示上次保留结果"); }
      try {
        const result = await this.runs.sample();
        this.snapshot.executions = result.executions.slice(0, 120).map(row => ({ ...row, command: row.command.slice(0, 300), commandTruncated: row.command.length > 300 }));
        this.stats.recordRuns(result.executions);
        if (result.executions.filter(row => ["working", "input_required"].includes(row.status)).length > 120) warnings.push("活动任务超过轻量列表上限 120；完整状态请在执行节点查询");
      } catch { warnings.push("运行记录采集失败，保留上次结果"); }
      try { this.snapshot.resources = await this.resources.sample(this.snapshot.executions); }
      catch { warnings.push("本机资源暂不可用"); }
      // Do not block the local Console snapshot on a slow or offline peer.
      void this.peers.poll().catch(() => undefined);
      this.snapshot.remote = { ...this.peers.readings };
      if (Date.now() - this.baseAt > 30_000) {
        try {
          const base = readConsoleSnapshot(this.options.stateDir, this.options.release ?? "independent-monitor");
          // Detailed events have their own on-demand endpoint; do not duplicate them in every live update.
          this.snapshot.base = { ...base, diagnostics: { count: base.diagnostics.count, requests: [], events: [] } };
          this.baseAt = Date.now();
        }
        catch { warnings.push("节点/工作流数据暂不可用"); }
      }
      this.snapshot = { ...this.snapshot, generatedAt: new Date().toISOString(), sampledAt: new Date().toISOString(), sampleMs: Date.now() - started, warnings };
      this.emit("snapshot", this.snapshot);
    } catch { this.snapshot.warnings = ["采集异常，稍后自动重试"]; }
    finally { this.busy = false; }
  }
}
