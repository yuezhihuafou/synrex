import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DiagnosticTrace, summarizeDiagnosticTrace } from "./diagnostic-trace.js";
import { readOtelFileTail, type HostMetricSample } from "./otel-file-reader.js";
import { readPeerSnapshot } from "./peer-observability.js";
import { LEGACY_UNVERIFIED_DISPATCH_SQL } from "./learning-store.js";
import { compareToolContracts } from "./multinode/protocol.js";

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
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string }>;
  memory: { episodes: number; successful: number; candidates: number; promoted: number };
  diagnostics: {
    count: number;
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

export function readConsoleSnapshot(stateDir: string, release: string): ConsoleSnapshot {
  const mainDb = path.join(stateDir, "devspace.sqlite");
  const workflowDb = path.join(stateDir, "coding-workflows.sqlite");
  const { nodes, tasks, memory } = readOnly(mainDb, {
    nodes: [] as ConsoleSnapshot["nodes"], tasks: [] as ConsoleSnapshot["tasks"],
    memory: { episodes: 0, successful: 0, candidates: 0, promoted: 0 },
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
          runId: row.run_id, createdAt: row.created_at,
        })),
      memory: {
        episodes: count(db, "select count(*) as n from learning_episodes"),
        successful: count(db, `select count(*) as n from learning_episodes where success = 1 and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}`),
        candidates: count(db, "select count(*) as n from learning_candidates"),
        promoted: count(db, "select count(*) as n from learning_candidates where status = 'promoted'"),
      },
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
  const requests = summarizeDiagnosticTrace(events).requests.slice(-40).reverse();
  const runtime = [...events].reverse().find(e => e.event === "runtime_sampled");
  const network = [...events].reverse().find(e => e.event === "network_sampled");
  const collector = [...events].reverse().find(e => e.event === "collector_sampled");
  return {
    generatedAt: new Date().toISOString(),
    service: { status: "online", release, diagnosticsBoundBytes: 2 * 8 * 1024 * 1024 },
    nodes, workflows, tasks, memory,
    diagnostics: { count: events.length, requests, events: events.slice(-200).reverse() },
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
