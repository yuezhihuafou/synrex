import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { DIAGNOSTIC_FILE_LIMIT, DiagnosticTrace, summarizeDiagnosticTrace } from "./diagnostic-trace.js";
import { summarizeConsoleObservability } from "./console-observability.js";
import { readOtelFileTail, type HostMetricSample } from "./otel-file-reader.js";
import { readPeerSnapshot } from "./peer-observability.js";
import { LEGACY_UNVERIFIED_DISPATCH_SQL } from "./learning-store.js";
import { compareToolContracts } from "./multinode/protocol.js";
import { readConversationLabels } from "./conversation-labels.js";
import { summarizeConsoleUsage, type UsageEpisode } from "./console-usage.js";
import { readStoredUsage } from "./usage-ledger.js";

interface NodeRow {
  id: string; kind: string; alias: string | null; health: string;
  platform_json: string; capabilities_json: string; last_seen_at: string;
}
interface WorkflowRow {
  workflow_id: string; workspace_root: string; title: string; goal: string;
  status: string; revision: number; checkpoint_json: string; updated_at: string;
}
interface TaskRow {
  task_id: string; node_id: string; workspace_id: string; run_id: string | null; created_at: string;
}

export interface ConsoleSnapshot {
  generatedAt: string;
  service: { status: "online"; release: string; diagnosticsBoundBytes: number };
  nodes: Array<{
    id: string; alias: string; kind: string; health: string; os: string;
    lastSeenAt: string; contract: { matching: number; missing: number; incompatible: number; total: number };
    version: string | null; fingerprint: string | null;
  }>;
  workflows: Array<{
    id: string; title: string; goal: string; workspace: string; status: string;
    revision: number; phase: string; summary: string; nextSteps: string[]; blockers: string[];
    taskIds: string[]; updatedAt: string;
  }>;
  conversationSessions: Array<{id:string;title:string;lastAt:string;requestCount:number;runningTasks:number;state:string;requests:Array<{requestId:string;tool?:string;lastAt:string;taskId?:string;runId?:string;classification:string}>}>;
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string; status: string; lastUpdatedAt?: string }>;
  activeTaskUnits: string[] | null;
  activeTaskProcesses: Array<{ unit: string; pid: number | null; memoryBytes: number | null; cpuTimeMs: number | null }> | null;
  memory: { episodes: number; successful: number; notes: number; candidates: number; promoted: number };
  usage: ReturnType<typeof summarizeConsoleUsage>;
  diagnostics: {
    count: number;
    observability: ReturnType<typeof summarizeConsoleObservability>;
    requests: ReturnType<typeof summarizeDiagnosticTrace>["requests"];
    events: ReturnType<DiagnosticTrace["read"]>;
  };
  observability: {
    collector: "bounded_tail" | "not_collected";
    peerSync: { gateway: "current" | "stale" | "unavailable"; at?: string };
    metrics: HostMetricSample[];
    runtime: {
      rssBytes?: number; heapUsedBytes?: number; eventLoopLagMs?: number;
      cpuUserMicros?: number; cpuSystemMicros?: number;
      eventLoopP95Ms?: number; eventLoopUtilizationPermille?: number;
      gcDurationMs?: number; gcCount?: number; activeToolCount?: number;
      otelSpanPending?: number; otelSpanDropped?: number;
      at?: string;
    };
    network: {
      tcpConnections?: number; tcpRttP50Ms?: number; tcpRttP95Ms?: number;
      tcpRetransSockets?: number; tcpRetransSegmentsTotal?: number;
      at?: string;
    };
    collectorHealth: {
      refusedLogs?: number; refusedMetrics?: number; exporterFailed?: number; at?: string;
    };
  };
}

function readOnly<T>(file: string, fallback: T, query: (db: Database.Database) => T): T {
  if (!existsSync(file)) return fallback;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return query(db); } finally { db.close(); }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const obj: unknown = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Record<string, unknown> : {};
  } catch { return {}; }
}
function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function strings(value: unknown, max = 8): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : [];
}
function count(db: Database.Database, statement: string): number {
  return Number((db.prepare(statement).get() as { n: number }).n);
}
function localTaskStatus(runId: string | null): { status: string; lastUpdatedAt?: string } {
  if (!runId || !/^run_[0-9]{14}_[a-z0-9]+$/.test(runId)) return { status: "unknown" };
  const root = process.env.DEVSPACE_COMPACT_RUN_ROOT || path.join(homedir(), ".local", "share", "devspace", "runs");
  const day = runId.slice(4,8)+"-"+runId.slice(8,10)+"-"+runId.slice(10,12);
  try {
    const file = path.join(root,day,runId,"task.json");
    if (!existsSync(file)) return { status: "unknown" };
    const state = JSON.parse(readFileSync(file,"utf8")) as {status?:string;lastUpdatedAt?:string};
    if (!["working","input_required","completed","failed","cancelled"].includes(state.status??"")) return {status:"unknown"};
    if (state.status==="working" && (!state.lastUpdatedAt || Date.now()-Date.parse(state.lastUpdatedAt)>120000)) {
      return {status:"stale_unverified",lastUpdatedAt:state.lastUpdatedAt};
    }
    return {status:state.status!,lastUpdatedAt:state.lastUpdatedAt};
  } catch { return {status:"unknown"}; }
}
function readActiveTaskUnits(): string[] | null {
  if (process.platform !== "linux") return null;
  try {
    const output=execFileSync("systemctl",["--user","list-units","devspace-task-*.service",
      "--type=service","--state=running","--no-legend","--plain","--no-pager"],
      {encoding:"utf8",timeout:800,maxBuffer:64*1024,stdio:["ignore","pipe","ignore"]});
    return output.split("\n").map(line=>line.trim().split(/\s+/)[0]??"")
      .filter(name=>/^devspace-task-[a-zA-Z0-9_-]+\.service$/.test(name)).slice(0,100);
  } catch {return null;}
}

/** One bounded systemd query for live runner PID/resource samples. Task route
 * indices are intentionally not used as proof that a process is alive. */
function readActiveTaskProcesses(units: string[] | null): ConsoleSnapshot["activeTaskProcesses"] {
  if (units === null) return null;
  if (units.length === 0) return [];
  type ProcessSample = NonNullable<ConsoleSnapshot["activeTaskProcesses"]>[number];
  const unknown = (unit: string): ProcessSample => ({ unit, pid: null, memoryBytes: null, cpuTimeMs: null });
  try {
    const output = execFileSync("systemctl", ["--user", "show", ...units,
      "--property=Id,MainPID,MemoryCurrent,CPUUsageNSec", "--no-pager"],
    { encoding: "utf8", timeout: 800, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const samples = new Map<string, ProcessSample>();
    const asNonnegative = (value: string | undefined): number | null => {
      if (!value || !/^\d+$/.test(value)) return null;
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : null;
    };
    for (const group of output.split(/\r?\n\s*\r?\n/)) {
      const fields = new Map(group.split(/\r?\n/).map(line => {
        const equals = line.indexOf("=");
        return equals < 0 ? ["", ""] : [line.slice(0, equals), line.slice(equals + 1)];
      }));
      const unit = fields.get("Id");
      if (!unit || !units.includes(unit)) continue;
      const pid = asNonnegative(fields.get("MainPID"));
      const cpuNs = asNonnegative(fields.get("CPUUsageNSec"));
      samples.set(unit, { unit, pid: pid && pid > 0 ? pid : null,
        memoryBytes: asNonnegative(fields.get("MemoryCurrent")),
        cpuTimeMs: cpuNs === null ? null : Math.round(cpuNs / 1_000_000) });
    }
    return units.map(unit => samples.get(unit) ?? unknown(unit));
  } catch { return units.map(unknown); }
}

export function readConsoleSnapshot(stateDir: string, release: string): ConsoleSnapshot {
  const mainDb = path.join(stateDir, "devspace.sqlite");
  const workflowDb = path.join(stateDir, "coding-workflows.sqlite");
  const { nodes, tasks, memory, usageEpisodes, usageEpisodesCapped, storedUsage } = readOnly(mainDb, {
    nodes: [] as ConsoleSnapshot["nodes"], tasks: [] as ConsoleSnapshot["tasks"],
    memory: { episodes: 0, successful: 0, notes: 0, candidates: 0, promoted: 0 },
    usageEpisodes: [] as UsageEpisode[], usageEpisodesCapped: false,
    storedUsage: { hourly: [], reviews: [] } as ReturnType<typeof readStoredUsage>,
  }, (db) => {
    const rows = db.prepare("select id, kind, alias, health, platform_json, capabilities_json, last_seen_at from execution_nodes order by last_seen_at desc limit 30").all() as NodeRow[];
    const allCapabilities = rows.map((row) => parseObject(row.capabilities_json));
    const local = allCapabilities[rows.findIndex((row) => row.kind === "local")];
    const localContracts = local?.toolContracts as Record<string, number> | undefined;
    return {
      nodes: rows.map((row, index) => {
        const platform = parseObject(row.platform_json);
        const capabilities = allCapabilities[index];
        const remoteContracts = capabilities.toolContracts as Record<string, number> | undefined;
        const compatibility = compareToolContracts(localContracts, remoteContracts);
        const runtime = capabilities.runtime && typeof capabilities.runtime === "object"
          ? capabilities.runtime as Record<string, unknown> : {};
        return {
          id: row.id, alias: row.alias ?? row.id, kind: row.kind, health: row.health,
          os: asText(platform.os, "unknown"), lastSeenAt: row.last_seen_at,
          contract: {
            matching: compatibility.matching, missing: compatibility.missing,
            incompatible: compatibility.incompatible, total: compatibility.total,
          },
          version: asText(runtime.version) || null,
          fingerprint: asText(runtime.buildFingerprint) || null,
        };
      }),
      tasks: (db.prepare("select task_id, node_id, workspace_id, run_id, created_at from task_routes order by created_at desc limit 30").all() as TaskRow[])
        .map((row) => ({
          id: row.task_id, nodeId: row.node_id, workspaceId: row.workspace_id,
          runId: row.run_id, createdAt: row.created_at, ...localTaskStatus(row.run_id),
        })),
      memory: {
        episodes: count(db, "select count(*) as n from learning_episodes"),
        successful: count(db, `select count(*) as n from learning_episodes where success = 1 and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}`),
        notes: db.prepare("select 1 from sqlite_master where type = 'table' and name = 'learning_notes'").get()
          ? count(db, "select count(*) as n from learning_notes") : 0,
        candidates: count(db, "select count(*) as n from learning_candidates"),
        promoted: count(db, "select count(*) as n from learning_candidates where status = 'promoted'"),
      },
      ...(() => {
        const rows = db.prepare(`select workspace_root, tool, output_summary, success, created_at
          from learning_episodes where created_at >= ? and tool in
          ('show_changes', 'apply_patch', 'semantic_edit', 'write', 'edit')
          order by created_at desc limit 5001`).all(new Date(Date.now() - 30 * 86400000).toISOString()) as UsageEpisode[];
        return { usageEpisodes: rows.slice(0, 5000), usageEpisodesCapped: rows.length > 5000 };
      })(),
      storedUsage: readStoredUsage(db),
    };
  });
  const workflows = readOnly(workflowDb, [] as ConsoleSnapshot["workflows"], (db) =>
    (db.prepare("select workflow_id, workspace_root, title, goal, status, revision, checkpoint_json, updated_at from coding_workflows order by updated_at desc limit 40").all() as WorkflowRow[])
      .map((row) => {
        const checkpoint = parseObject(row.checkpoint_json);
        return {
          id: row.workflow_id, title: row.title, goal: row.goal,
          workspace: path.basename(row.workspace_root), status: row.status,
          revision: row.revision, phase: asText(checkpoint.phase),
          summary: asText(checkpoint.summary),
          nextSteps: strings(checkpoint.nextSteps), blockers: strings(checkpoint.blockers),
          taskIds: strings(checkpoint.taskIds), updatedAt: row.updated_at,
        };
      }),
  );
  const archive = readOtelFileTail(stateDir);
  const peer = readPeerSnapshot(stateDir);
  const recent = new DiagnosticTrace(stateDir).read({ minutes: 24 * 60, limit: 2000 });
  const combined = [...peer.events, ...archive.logs, ...recent].sort((a,b) => a.ts.localeCompare(b.ts));
  const unique = new Map(combined.map((e) => [
    [e.ts,e.event,e.requestId,e.callId,e.stage,e.nodeRequestId,e.taskId].join("|"), e,
  ]));
  const events = [...unique.values()].slice(-2000);
  const allRequests = summarizeDiagnosticTrace(events).requests;
  const ownerLabels = new Map(readConversationLabels(stateDir,allRequests.slice(-300).map(r=>r.requestId))
    .map(label=>[label.requestId,label.conversationTitle]));
  const requests=allRequests.slice(-300).reverse().map(r=>({...r,
    ...(ownerLabels.has(r.requestId)?{conversationTitle:ownerLabels.get(r.requestId)}:{}),
  }));
  const allEvents = new DiagnosticTrace(stateDir).read({ minutes: 30 * 24 * 60, limit: 20000 });
  const byConversation = new Map<string, typeof requests>();
  for (const request of requests) {
    if (!request.conversationId) continue;
    const existing = byConversation.get(request.conversationId) ?? [];
    existing.push(request);
    byConversation.set(request.conversationId,existing);
  }
  const conversationSessions=[...byConversation].map(([id,items])=>{
    const ordered=items.sort((a,b)=>b.lastAt.localeCompare(a.lastAt));
    const recent=ordered[0]!;
    const runningTasks=items.filter(x=>x.taskId && tasks.some(t=>t.id===x.taskId && (t.status==="working"||t.status==="input_required"))).length;
    return {id,title:recent.conversationTitle??id,lastAt:recent.lastAt,requestCount:items.length,runningTasks,
      state:runningTasks?"task_running":Date.now()-Date.parse(recent.lastAt)<30000?"recent_mcp_activity":"no_recent_mcp_activity",
      requests:ordered.slice(0,80).map(r=>({requestId:r.requestId,tool:r.tool,lastAt:r.lastAt,taskId:r.taskId,runId:r.runId,classification:r.classification}))};
  }).sort((a,b)=>b.lastAt.localeCompare(a.lastAt)).slice(0,40);
  const runtime = [...events].reverse().find(e => e.event === "runtime_sampled");
  const network = [...events].reverse().find(e => e.event === "network_sampled");
  const collector = [...events].reverse().find(e => e.event === "collector_sampled");
  const activeTaskUnits = readActiveTaskUnits();
  return {
    generatedAt: new Date().toISOString(),
    service: { status: "online", release, diagnosticsBoundBytes: 2 * DIAGNOSTIC_FILE_LIMIT },
    nodes, workflows, tasks, memory, conversationSessions, activeTaskUnits,
    activeTaskProcesses: readActiveTaskProcesses(activeTaskUnits),
    usage: summarizeConsoleUsage(allEvents, usageEpisodes, Date.now(), {
      diagnostics: allEvents.length >= 20000,
      episodes: usageEpisodesCapped,
    }, storedUsage),
    diagnostics: { count: events.length,
      observability: summarizeConsoleObservability(events),
      requests, events: events.slice(-200).reverse() },
    observability: {
      collector: archive.coverage,
      peerSync: { gateway: peer.coverage, at: peer.updatedAt },
      metrics: archive.metrics.slice(-120),
      runtime: {
        rssBytes: runtime?.rssBytes, heapUsedBytes: runtime?.heapUsedBytes,
        eventLoopLagMs: runtime?.eventLoopLagMs,
        cpuUserMicros: runtime?.cpuUserMicros, cpuSystemMicros: runtime?.cpuSystemMicros, at: runtime?.ts,
        eventLoopP95Ms: runtime?.eventLoopP95Ms,
        eventLoopUtilizationPermille: runtime?.eventLoopUtilizationPermille,
        gcDurationMs: runtime?.gcDurationMs, gcCount: runtime?.gcCount,
        activeToolCount: runtime?.activeToolCount,
        otelSpanPending: runtime?.otelSpanPending, otelSpanDropped: runtime?.otelSpanDropped,
      },
      network: {
        tcpConnections: network?.tcpConnections, tcpRttP50Ms: network?.tcpRttP50Ms,
        tcpRttP95Ms: network?.tcpRttP95Ms, tcpRetransSockets: network?.tcpRetransSockets,
        tcpRetransSegmentsTotal: network?.tcpRetransSegmentsTotal, at: network?.ts,
      },
      collectorHealth: {
        refusedLogs: collector?.collectorRefusedLogRecords,
        refusedMetrics: collector?.collectorRefusedMetricPoints,
        exporterFailed: collector?.collectorExporterFailed,
        at: collector?.ts,
      },
    },
  };
}
