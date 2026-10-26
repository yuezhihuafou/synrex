import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

// Supplemental, additive tables in the existing owner database. No new DB,
// schema-migration version, network endpoint, or model-side instrumentation.
// Older pinned releases safely ignore these tables on rollback.
const CREATE = `
  create table if not exists usage_traffic_hourly (
    hour text primary key, requests integer not null, completed integer not null,
    tool_calls integer not null, input_bytes integer not null, output_bytes integer not null,
    input_measured integer not null, output_measured integer not null,
    tool_counts_json text not null
  );
  create table if not exists usage_code_reviews (
    workspace_root text not null, review_ref text not null, created_at text not null,
    files integer not null, additions integer not null, removals integer not null,
    path_hashes_json text not null, paths_complete integer not null,
    primary key (workspace_root, review_ref)
  );
  create index if not exists usage_code_reviews_created_idx on usage_code_reviews(created_at);
`;

export interface HourlyUsage {
  hour: string; requests: number; completed: number; tool_calls: number;
  input_bytes: number; output_bytes: number; input_measured: number; output_measured: number;
  tool_counts_json: string;
}
export interface StoredReview {
  workspace_root: string; review_ref: string; created_at: string; files: number;
  additions: number; removals: number; path_hashes_json: string; paths_complete: number;
}
type Counter = Omit<HourlyUsage, "hour" | "tool_counts_json"> & { tools: Record<string, number> };

const zero = (): Counter => ({ requests: 0, completed: 0, tool_calls: 0, input_bytes: 0,
  output_bytes: 0, input_measured: 0, output_measured: 0, tools: {} });
const tableExists = (db: Database.Database, name: string): boolean =>
  Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));

/** Optional batching observer: transient telemetry failure never interrupts MCP. */
export class UsageTrafficRecorder {
  private readonly pending = new Map<string, Counter>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private readonly stateDir: string) {}

  record(event: DiagnosticEntry): void {
    if (this.stopped || !["mcp_received", "mcp_finished", "tool_execution_started"].includes(event.event)) return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    const hour = new Date(at).toISOString().slice(0, 13) + ":00:00.000Z";
    const value = this.pending.get(hour) ?? zero();
    this.pending.set(hour, value);
    if (event.event === "mcp_received") {
      value.requests++;
      if (typeof event.inputBytes === "number") { value.input_bytes += event.inputBytes; value.input_measured++; }
    } else if (event.event === "mcp_finished") {
      value.completed++;
      if (typeof event.outputBytes === "number") { value.output_bytes += event.outputBytes; value.output_measured++; }
    } else {
      value.tool_calls++;
      if (event.tool) value.tools[event.tool] = (value.tools[event.tool] ?? 0) + 1;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 3_000);
      this.timer.unref?.();
    }
  }

  flush(): boolean {
    if (!this.pending.size) return true;
    let db: Database.Database | undefined;
    try {
      db = new Database(path.join(this.stateDir, "devspace.sqlite"), { fileMustExist: true, timeout: 300 });
      db.pragma("busy_timeout = 300");
      db.exec(CREATE);
      const select = db.prepare("select tool_counts_json from usage_traffic_hourly where hour = ?");
      const upsert = db.prepare(`insert into usage_traffic_hourly
        (hour, requests, completed, tool_calls, input_bytes, output_bytes, input_measured, output_measured, tool_counts_json)
        values (@hour, @requests, @completed, @tool_calls, @input_bytes, @output_bytes, @input_measured, @output_measured, @tool_counts_json)
        on conflict(hour) do update set requests = requests + excluded.requests,
        completed = completed + excluded.completed, tool_calls = tool_calls + excluded.tool_calls,
        input_bytes = input_bytes + excluded.input_bytes, output_bytes = output_bytes + excluded.output_bytes,
        input_measured = input_measured + excluded.input_measured,
        output_measured = output_measured + excluded.output_measured,
        tool_counts_json = excluded.tool_counts_json`);
      db.transaction(() => {
        for (const [hour, current] of this.pending) {
          let tools: Record<string, number> = {};
          const stored = select.get(hour) as { tool_counts_json: string } | undefined;
          if (stored) {
            try { tools = JSON.parse(stored.tool_counts_json) as Record<string, number>; } catch { tools = {}; }
          }
          for (const [tool, count] of Object.entries(current.tools)) tools[tool] = (tools[tool] ?? 0) + count;
          upsert.run({ hour, requests: current.requests, completed: current.completed,
            tool_calls: current.tool_calls, input_bytes: current.input_bytes, output_bytes: current.output_bytes,
            input_measured: current.input_measured, output_measured: current.output_measured,
            tool_counts_json: JSON.stringify(tools) });
        }
        db!.prepare("delete from usage_traffic_hourly where hour < ?")
          .run(new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 13) + ":00:00.000Z");
      })();
      this.pending.clear();
      return true;
    } catch {
      // Retain unsaved counters for next flush. No telemetry error may propagate.
      return false;
    } finally { db?.close(); }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.stopped = true;
  }
}

export function recordCodeReview(db: Database.Database, review: StoredReview): void {
  try {
    db.exec(CREATE);
    db.prepare(`insert or ignore into usage_code_reviews
      (workspace_root, review_ref, created_at, files, additions, removals, path_hashes_json, paths_complete)
      values (@workspace_root, @review_ref, @created_at, @files, @additions, @removals, @path_hashes_json, @paths_complete)`)
      .run(review);
  } catch { /* Observational: do not change the outcome of the code operation. */ }
}

export function readStoredUsage(db: Database.Database): { hourly: HourlyUsage[]; reviews: StoredReview[] } {
  return {
    hourly: tableExists(db, "usage_traffic_hourly")
      ? db.prepare("select * from usage_traffic_hourly where hour >= ? order by hour asc")
        .all(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 13) + ":00:00.000Z") as HourlyUsage[] : [],
    reviews: tableExists(db, "usage_code_reviews")
      ? db.prepare("select * from usage_code_reviews where created_at >= ? order by created_at desc limit 5001")
        .all(new Date(Date.now() - 30 * 86400000).toISOString()) as StoredReview[] : [],
  };
}
