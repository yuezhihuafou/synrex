import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

/** No new collector or agent daemon dependency: only existing local evidence. */
export interface DelegationMetrics {
  window: "24h";
  source: {
    scope: "local_workspace";
    diagnosticsCapped: boolean;
    agentRecordsCapped: boolean;
    agentsAvailable: boolean;
    note: string;
  };
  totals: {
    observedMcpToolCalls: number;
    agentSessionsStarted: number;
    agentTurnsCompleted: number;
    agentTurnsFailed: number;
    agentExecutionMs: number;
    agentTurnSuccessPercent: number | null;
    userTaskSuccessPercent: null;
  };
  workspaces: Array<{
    workspaceId: string;
    observedMcpToolCalls: number;
    agentSessionsStarted: number;
    agentTurnsCompleted: number;
    agentTurnsFailed: number;
    agentExecutionMs: number;
  }>;
  agentTasks: Array<{
    agentId: string;
    workspaceId: string;
    provider: string;
    state: string;
    createdAt: string;
    finishedTurns: number;
    failedTurns: number;
    executionMs: number;
  }>;
}

interface AgentRow {
  id: string; workspace_id: string | null; provider: string; status: string; created_at: string;
}
interface TurnRow {
  agent_id: string; workspace_id: string | null; provider: string; status: string;
  created_at: string; kind: string; duration_ms: number | null; at: string;
}

const PERIOD_MS = 86_400_000;
const SESSION_LIMIT = 500;
const TURN_LIMIT = 1500;
const UNATTRIBUTED = "unattributed";

export function readDelegationMetrics(
  stateDir: string,
  events: readonly DiagnosticEntry[],
  now = Date.now(),
  diagnosticsCapped = false,
): DelegationMetrics {
  const cutoff = new Date(now - PERIOD_MS).toISOString();
  const source: DelegationMetrics["source"] = {
    scope: "local_workspace", diagnosticsCapped, agentRecordsCapped: false,
    agentsAvailable: false,
    note: "Owner-observed MCP tool calls (including routed requests) and owner-local agent turns are grouped by workspace, not by a verified user task. Agent-turn success is not user-goal success; remote agent histories and truncated events are excluded.",
  };
  const workspaces = new Map<string, DelegationMetrics["workspaces"][number]>();
  const group = (id: string | null | undefined) => {
    const workspaceId = id || UNATTRIBUTED;
    let current = workspaces.get(workspaceId);
    if (!current) {
      current = { workspaceId, observedMcpToolCalls: 0, agentSessionsStarted: 0,
        agentTurnsCompleted: 0, agentTurnsFailed: 0, agentExecutionMs: 0 };
      workspaces.set(workspaceId, current);
    }
    return current;
  };
  for (const event of events) {
    if (event.event !== "tool_execution_started" || event.ts < cutoff || Date.parse(event.ts) > now) continue;
    group(event.workspaceId).observedMcpToolCalls++;
  }

  let sessions: AgentRow[] = [];
  let turns: TurnRow[] = [];
  const dbFile = path.join(stateDir, "devspace.sqlite");
  if (existsSync(dbFile)) {
    try {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const present = db.prepare("select 1 from sqlite_master where type='table' and name='local_agent_sessions'").get();
        if (present) {
          sessions = db.prepare(`select id,workspace_id,provider,status,created_at
            from local_agent_sessions where created_at>=? order by created_at desc limit ?`)
            .all(cutoff, SESSION_LIMIT) as AgentRow[];
          // The optional daemon creates its telemetry table on first use.
          // A fresh Core/Console must remain readable before any agent starts.
          const eventsPresent = db.prepare("select 1 from sqlite_master where type='table' and name='local_agent_events'").get();
          if (eventsPresent) {
            turns = db.prepare(`select e.agent_id,a.workspace_id,a.provider,a.status,a.created_at,
              e.kind,e.duration_ms,e.at from local_agent_events e
              join local_agent_sessions a on a.id=e.agent_id
              where e.at>=? and e.kind in ('turn_completed','turn_failed')
              order by e.at desc limit ?`).all(cutoff, TURN_LIMIT) as TurnRow[];
          }
          source.agentsAvailable = Boolean(eventsPresent);
          source.agentRecordsCapped = sessions.length === SESSION_LIMIT || turns.length === TURN_LIMIT;
        }
      } finally { db.close(); }
    } catch {
      // Optional read-only metrics must never break independent snapshots
      // while SQLite is migrating, busy or temporarily unavailable.
      sessions = []; turns = []; source.agentsAvailable = false;
    }
  }
  const agentMap = new Map<string, DelegationMetrics["agentTasks"][number]>();
  for (const session of sessions) {
    group(session.workspace_id).agentSessionsStarted++;
    agentMap.set(session.id, { agentId: session.id,
      workspaceId: session.workspace_id || UNATTRIBUTED, provider: session.provider,
      state: session.status, createdAt: session.created_at,
      finishedTurns: 0, failedTurns: 0, executionMs: 0 });
  }
  for (const turn of turns) {
    const row = group(turn.workspace_id);
    if (turn.kind === "turn_completed") row.agentTurnsCompleted++;
    else row.agentTurnsFailed++;
    const duration = typeof turn.duration_ms === "number" && Number.isFinite(turn.duration_ms)
      ? Math.max(0, turn.duration_ms) : 0;
    row.agentExecutionMs += duration;
    let agent = agentMap.get(turn.agent_id);
    if (!agent) {
      agent = { agentId: turn.agent_id, workspaceId: turn.workspace_id || UNATTRIBUTED,
        provider: turn.provider, state: turn.status, createdAt: turn.created_at,
        finishedTurns: 0, failedTurns: 0, executionMs: 0 };
      agentMap.set(turn.agent_id, agent);
    }
    agent.finishedTurns++;
    if (turn.kind === "turn_failed") agent.failedTurns++;
    agent.executionMs += duration;
  }
  const totals = { observedMcpToolCalls: 0, agentSessionsStarted: 0,
    agentTurnsCompleted: 0, agentTurnsFailed: 0, agentExecutionMs: 0,
    agentTurnSuccessPercent: null as number | null, userTaskSuccessPercent: null };
  for (const row of workspaces.values()) {
    totals.observedMcpToolCalls += row.observedMcpToolCalls;
    totals.agentSessionsStarted += row.agentSessionsStarted;
    totals.agentTurnsCompleted += row.agentTurnsCompleted;
    totals.agentTurnsFailed += row.agentTurnsFailed;
    totals.agentExecutionMs += row.agentExecutionMs;
  }
  const terminal = totals.agentTurnsCompleted + totals.agentTurnsFailed;
  if (terminal) totals.agentTurnSuccessPercent = Math.round(totals.agentTurnsCompleted / terminal * 100);
  return { window: "24h", source, totals,
    workspaces: [...workspaces.values()]
      .sort((a, b) => b.observedMcpToolCalls - a.observedMcpToolCalls || b.agentSessionsStarted - a.agentSessionsStarted)
      .slice(0, 25),
    agentTasks: [...agentMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25),
  };
}
