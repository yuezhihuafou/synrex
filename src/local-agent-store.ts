import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

export type LocalAgentEventKind = "turn_started" | "progress" | "session_saved" | "turn_completed" | "turn_failed";

export interface LocalAgentEventData {
  label?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  outputBytes?: number;
}

export interface LocalAgentEvent extends LocalAgentEventData {
  seq: number;
  agentId: string;
  at: string;
  kind: LocalAgentEventKind;
}

export interface LocalAgentStats {
  sessions: number;
  running: number;
  completed: number;
  failed: number;
  turns: number;
  successfulTurns: number;
  failedTurns: number;
  durationMs: number;
  /** Null means the provider did not report this measurement. */
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
  outputBytes: number | null;
  byProvider: Record<string, { sessions: number; turns: number; successfulTurns: number; failedTurns: number; durationMs: number }>;
}

interface LocalAgentEventRow {
  seq: number; agent_id: string; at: string; kind: LocalAgentEventKind; label: string | null;
  duration_ms: number | null; input_tokens: number | null; output_tokens: number | null;
  thinking_tokens: number | null; cache_read_tokens: number | null;
  total_tokens: number | null; output_bytes: number | null;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    // Additive telemetry extension: intentionally no new global migration
    // version, so an older pinned Synrex release can still open this SQLite
    // database after rollback. No pre-existing tables are changed.
    this.database.sqlite.exec(`
      create table if not exists local_agent_events (
        seq integer primary key autoincrement,
        agent_id text not null references local_agent_sessions(id) on delete cascade,
        at text not null,
        kind text not null,
        label text,
        duration_ms integer,
        input_tokens integer,
        output_tokens integer,
        thinking_tokens integer,
        cache_read_tokens integer,
        total_tokens integer,
        output_bytes integer
      );
      create index if not exists local_agent_events_agent_seq_idx
        on local_agent_events(agent_id, seq);
    `);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  appendEvent(agentId: string, kind: LocalAgentEventKind, details: LocalAgentEventData = {}): LocalAgentEvent {
    const at = new Date().toISOString();
    const row = this.database.sqlite.prepare(`
      insert into local_agent_events (
        agent_id, at, kind, label, duration_ms, input_tokens, output_tokens,
        thinking_tokens, cache_read_tokens, total_tokens, output_bytes
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId, at, kind, details.label?.slice(0, 128) ?? null,
      details.durationMs ?? null, details.inputTokens ?? null,
      details.outputTokens ?? null, details.thinkingTokens ?? null,
      details.cacheReadTokens ?? null, details.totalTokens ?? null,
      details.outputBytes ?? null,
    );
    return { seq: Number(row.lastInsertRowid), agentId, at, kind, ...details };
  }

  appendEventResult(agentId: string, kind: LocalAgentEventKind, details: LocalAgentEventData = {}): BetterResult<LocalAgentEvent, AgentStoreError> {
    return storeResult("append_agent_event", () => this.appendEvent(agentId, kind, details));
  }

  listEvents(agentId: string, afterSeq = 0, limit = 100): LocalAgentEvent[] {
    const rows = this.database.sqlite.prepare(`
      select * from local_agent_events where agent_id = ? and seq > ?
      order by seq asc limit ?
    `).all(agentId, afterSeq, Math.min(500, Math.max(1, limit))) as LocalAgentEventRow[];
    return rows.map(eventFromRow);
  }

  listEventsResult(agentId: string, afterSeq = 0, limit = 100): BetterResult<LocalAgentEvent[], AgentStoreError> {
    return storeResult("list_agent_events", () => this.listEvents(agentId, afterSeq, limit));
  }

  stats(scope: LocalAgentListScope): LocalAgentStats {
    const agents = this.list(scope);
    const summary: LocalAgentStats = {
      sessions: agents.length, running: 0, completed: 0, failed: 0,
      turns: 0, successfulTurns: 0, failedTurns: 0, durationMs: 0,
      inputTokens: null, outputTokens: null, thinkingTokens: null,
      cacheReadTokens: null, totalTokens: null, outputBytes: null,
      byProvider: Object.create(null) as LocalAgentStats["byProvider"],
    };
    for (const agent of agents) {
      if (agent.status === "running" || agent.status === "starting") summary.running++;
      if (agent.status === "idle") summary.completed++;
      if (agent.status === "error") summary.failed++;
      summary.byProvider[agent.provider] ??= {
        sessions: 0, turns: 0, successfulTurns: 0, failedTurns: 0, durationMs: 0,
      };
      summary.byProvider[agent.provider].sessions++;
    }
    const matching = new Set(agents.map((agent) => agent.id));
    if (matching.size === 0) return summary;
    const rows = this.database.sqlite.prepare(`
      select e.*, a.provider from local_agent_events e
      join local_agent_sessions a on a.id = e.agent_id
      where a.workspace_root = ? and (? is null or a.workspace_id = ?)
        and e.kind in ('turn_completed', 'turn_failed')
    `).all(resolve(scope.workspaceRoot ?? ""), scope.workspaceId ?? null, scope.workspaceId ?? null) as (LocalAgentEventRow & { provider: string })[];
    const sum = (a: number | null, b: number | null): number | null => b === null ? a : (a ?? 0) + b;
    for (const event of rows) {
      if (!matching.has(event.agent_id)) continue;
      const provider = summary.byProvider[event.provider];
      if (!provider) continue;
      summary.turns++; provider.turns++;
      if (event.kind === "turn_completed") { summary.successfulTurns++; provider.successfulTurns++; }
      else { summary.failedTurns++; provider.failedTurns++; }
      summary.durationMs += event.duration_ms ?? 0;
      provider.durationMs += event.duration_ms ?? 0;
      summary.inputTokens = sum(summary.inputTokens, event.input_tokens);
      summary.outputTokens = sum(summary.outputTokens, event.output_tokens);
      summary.thinkingTokens = sum(summary.thinkingTokens, event.thinking_tokens);
      summary.cacheReadTokens = sum(summary.cacheReadTokens, event.cache_read_tokens);
      summary.totalTokens = sum(summary.totalTokens, event.total_tokens);
      summary.outputBytes = sum(summary.outputBytes, event.output_bytes);
    }
    return summary;
  }

  statsResult(scope: LocalAgentListScope): BetterResult<LocalAgentStats, AgentStoreError> {
    return storeResult("agent_stats", () => this.stats(scope));
  }

  reconcileActiveRuns(message = "Synrex restarted while this agent turn was running."): number {
    const now = new Date().toISOString();
    return this.database.sqlite.transaction(() => {
      const interrupted = this.database.sqlite
        .prepare("select id from local_agent_sessions where status in ('starting', 'running')")
        .all() as Array<{ id: string }>;
      if (interrupted.length === 0) return 0;
      const result = this.database.sqlite
        .prepare(
          `update local_agent_sessions
           set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
           where status in ('starting', 'running')`,
        )
        .run(message, now);
      for (const row of interrupted) {
        this.appendEvent(row.id, "turn_failed", { label: "DAEMON_UNAVAILABLE" });
      }
      return Number(result.changes);
    })();
  }

  reconcileActiveRunsResult(
    message = "Synrex restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  close(): void {
    this.database.close();
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function eventFromRow(row: LocalAgentEventRow): LocalAgentEvent {
  const values: LocalAgentEventData = {
    ...(row.label !== null ? { label: row.label } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.thinking_tokens !== null ? { thinkingTokens: row.thinking_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
    ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    ...(row.output_bytes !== null ? { outputBytes: row.output_bytes } : {}),
  };
  return { seq: row.seq, agentId: row.agent_id, at: row.at, kind: row.kind, ...values };
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}
