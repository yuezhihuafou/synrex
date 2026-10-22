import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { normalizeEvent, type MonitorEvent } from "./events.js";
import type { Execution, MetricSummary, Statistics, StatsFilter } from "./types.js";

export const HISTORY_LIMIT = 20_000;
export const RETENTION_DAYS = 7;
type RequestMetric = { id: string; at: string; tool: string; workspace: string; status: string; duration: number | null };
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function summarize(rows: RequestMetric[]): MetricSummary {
  const durations = rows.filter(r => r.duration !== null).map(r => r.duration!);
  return { count: rows.length, ok: rows.filter(r => r.status === "ok").length,
    errors: rows.filter(r => r.status === "error").length,
    incomplete: rows.filter(r => r.status === "incomplete").length, latencyCount: durations.length,
    p50: percentile(durations, .5), p95: percentile(durations, .95) };
}

export class StatisticsStore {
  readonly db: Database.Database;
  readonly observationStartedAt: string;
  private lastPrune = 0;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { timeout: 200 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("journal_size_limit = 1048576");
    this.db.pragma("max_page_count = 8192");
    this.db.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists events (id text primary key, at text not null, request_id text, tool text, workspace text, event text not null, body text not null);
      create index if not exists events_at on events(at);
      create index if not exists events_request on events(request_id);
      create table if not exists requests (id text primary key, at text not null, started text, tool text not null default '', workspace text not null default '', status text not null default 'incomplete', duration real, tool_error integer not null default 0);
      create index if not exists requests_at on requests(at);
      create table if not exists runs (id text primary key, at text not null, workspace text, status text, duration real);
      create index if not exists runs_at on runs(at);
      create table if not exists receipts (id text primary key, at text not null, action text, target text, status text);
      create table if not exists cursors (file text primary key, inode text not null, offset integer not null);
    `);
    this.db.prepare("insert or ignore into meta values ('started', ?)").run(new Date().toISOString());
    const normalizer = this.db.prepare("select value from meta where key='normalizer'").get() as {value:string}|undefined;
    if(normalizer?.value!=="2") { this.db.exec("delete from cursors"); this.db.prepare("insert or replace into meta values ('normalizer','2')").run(); }
    this.observationStartedAt = (this.db.prepare("select value from meta where key='started'").get() as { value: string }).value;
  }
  close() { this.db.close(); }

  ingest(entries: unknown[]) {
    const insert = this.db.prepare("insert or ignore into events values (?,?,?,?,?,?,?)");
    const get = this.db.prepare("select * from requests where id=?");
    const save = this.db.prepare(`insert into requests(id,at,started,tool,workspace,status,duration,tool_error) values (@id,@at,@started,@tool,@workspace,@status,@duration,@tool_error)
      on conflict(id) do update set at=excluded.at,started=excluded.started,tool=excluded.tool,workspace=excluded.workspace,status=excluded.status,duration=excluded.duration,tool_error=excluded.tool_error`);
    this.db.transaction(() => {
      for (const raw of entries) {
        const entry = normalizeEvent(raw);
        if(!entry) continue;
        const body = JSON.stringify(entry), id = createHash("sha256").update(body).digest("hex");
        if (!insert.run(id, entry.ts, entry.requestId ?? null, entry.tool ?? "", entry.workspaceId ?? "", entry.event, body).changes || !entry.requestId) continue;
        const old = get.get(entry.requestId) as (RequestMetric & { started: string | null; tool_error: number }) | undefined;
        const r = { id: entry.requestId, at: old?.at && old.at > entry.ts ? old.at : entry.ts,
          started: old?.started ?? null, tool: entry.tool ?? old?.tool ?? "", workspace: entry.workspaceId ?? old?.workspace ?? "",
          status: old?.status ?? "incomplete", duration: old?.duration ?? null, tool_error: old?.tool_error ?? 0 };
        if (entry.event === "mcp_received") r.started = entry.ts;
        if (entry.event === "tool_execution_finished" && entry.outcome === "error") { r.tool_error = 1; r.status = "error"; }
        if (["mcp_failed", "mcp_closed_early"].includes(entry.event)) r.status = "error";
        if (entry.event === "mcp_finished") {
          r.status = r.tool_error || (entry.status ?? 200) >= 400 ? "error" : "ok";
          r.duration = entry.durationMs ?? (r.started ? Math.max(0, Date.parse(entry.ts) - Date.parse(r.started)) : null);
        }
        if (r.tool_error) r.status = "error";
        save.run(r);
      }
    })();
    this.prune();
  }

  recordRuns(runs: Execution[]) {
    const put = this.db.prepare("insert into runs values (?,?,?,?,?) on conflict(id) do update set status=excluded.status,duration=excluded.duration");
    this.db.transaction(() => { for (const r of runs) put.run(r.runId, r.startedAt, r.workspaceId ?? r.project, r.status, r.finishedAt ? r.durationMs : null); })();
    this.prune();
  }

  /** Incremental, restart-safe tail; rotated event replays are deduplicated. */
  async collectDiagnostics(stateDir: string) {
    for (const name of ["recent.jsonl.1", "recent.jsonl"]) {
      const file = path.join(stateDir, "diagnostics", name);
      const handle = await open(file, "r").catch(() => null);
      if (!handle) continue;
      try {
        const info = await handle.stat(), inode = `${info.dev}:${info.ino}`;
        const previous = this.db.prepare("select inode,offset from cursors where file=?").get(file) as { inode: string; offset: number } | undefined;
        let offset = previous?.inode === inode && previous.offset <= info.size ? previous.offset : 0;
        let skipFirst = false;
        if (info.size - offset > 2 * 1024 * 1024) { offset = info.size - 2 * 1024 * 1024; skipFirst = true; }
        const buffer = Buffer.alloc(Math.min(info.size - offset, 2 * 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (end < 0) continue;
        const lines = buffer.subarray(0, end + 1).toString("utf8").split("\n");
        if (skipFirst) lines.shift();
        const rows: unknown[] = [];
        for (const line of lines) { try { if (line) rows.push(JSON.parse(line)); } catch { /* truncated rotation */ } }
        this.ingest(rows);
        this.db.prepare("insert into cursors values (?,?,?) on conflict(file) do update set inode=excluded.inode,offset=excluded.offset").run(file, inode, offset + end + 1);
      } finally { await handle.close(); }
    }
  }

  query(filter: StatsFilter): Statistics {
    const until = new Date(), since = new Date(until.getTime() - Math.min(7 * 1440, Math.max(1, filter.minutes)) * 60_000).toISOString();
    const clauses = ["at >= ?"], args: string[] = [since];
    if (filter.tool) { clauses.push("tool = ?"); args.push(filter.tool); }
    if (filter.workspace) { clauses.push("workspace = ?"); args.push(filter.workspace); }
    const rows = this.db.prepare(`select id,at,tool,workspace,status,duration from requests where ${clauses.join(" and ")} order by at desc limit ${HISTORY_LIMIT}`).all(...args) as RequestMetric[];
    const names = [...new Set(rows.map(r => r.tool || "HTTP/MCP"))];
    const tools = names.map(name => ({ name, ...summarize(rows.filter(r => (r.tool || "HTTP/MCP") === name)) }));
    const start = Date.parse(since), width = (until.getTime() - start) / 24;
    const series = Array.from({ length: 24 }, (_, i) => ({ at: new Date(start + i * width).toISOString(), count: 0, errors: 0 }));
    for (const row of rows) { const bucket = series[Math.min(23, Math.max(0, Math.floor((Date.parse(row.at) - start) / width)))]; bucket.count++; if (row.status === "error") bucket.errors++; }
    const runs = this.db.prepare(`select status,duration from runs where at >= ? ${filter.workspace ? "and workspace = ?" : ""} limit ${HISTORY_LIMIT}`).all(...(filter.workspace ? [since, filter.workspace] : [since])) as { status: string; duration: number | null }[];
    const durations = runs.filter(r => r.duration !== null).map(r => r.duration!);
    const stageRows = this.db.prepare(`select id,at,coalesce(tool,'') as tool,coalesce(workspace,'') as workspace,
      coalesce(json_extract(body,'$.stage'),'unknown') as name,
      case when json_extract(body,'$.outcome')='error' then 'error' else 'ok' end as status,
      json_extract(body,'$.durationMs') as duration from events where event='stage_finished' and ${clauses.join(" and ")} limit ${HISTORY_LIMIT}`).all(...args) as Array<RequestMetric&{name:string}>;
    const stages = [...new Set(stageRows.map(x=>x.name))].map(name=>({name,...summarize(stageRows.filter(x=>x.name===name))}));
    return { since, until: until.toISOString(), observationStartedAt: this.observationStartedAt,
      coverage: "保留窗口内已观测数据；历史日志可能已轮转，最多 7 天 / 每类 20,000 条。调用成功与任务验收分别统计。",
      requests: summarize(rows), tools, stages, series,
      tasks: { count: runs.length, completed: runs.filter(r => r.status === "completed").length, failed: runs.filter(r => r.status === "failed").length,
        cancelled: runs.filter(r => r.status === "cancelled").length, active: runs.filter(r => ["working", "input_required"].includes(r.status)).length,
        p50: percentile(durations, .5), p95: percentile(durations, .95) },
      options: { tools: (this.db.prepare("select distinct tool from requests where tool != '' order by tool").all() as { tool: string }[]).map(x => x.tool),
        workspaces: (this.db.prepare("select distinct workspace from requests where workspace != '' order by workspace").all() as { workspace: string }[]).map(x => x.workspace) } };
  }

  events(query = "", request = "") {
    const rows = this.db.prepare(`select body from events ${request ? "where request_id = ?" : ""} order by at desc limit 400`).all(...(request ? [request] : [])) as { body: string }[];
    return rows.map(x => JSON.parse(x.body) as MonitorEvent).filter(x => JSON.stringify(x).toLowerCase().includes(query.toLowerCase())).slice(0, 200);
  }
  receipt(id: string, action: string, target: string, status: string) {
    this.db.prepare("insert or ignore into receipts values (?,?,?,?,?)").run(id, new Date().toISOString(), action, target, status);
  }
  receipts() { return this.db.prepare("select * from receipts order by at desc limit 50").all(); }
  private prune() {
    if (Date.now() - this.lastPrune < 60_000) return;
    this.lastPrune = Date.now();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
    for (const table of ["events", "requests", "runs", "receipts"]) {
      this.db.prepare(`delete from ${table} where at < ?`).run(cutoff);
      this.db.exec(`delete from ${table} where rowid in (select rowid from ${table} order by at desc limit -1 offset ${table === "receipts" ? 1000 : HISTORY_LIMIT})`);
    }
  }
}
