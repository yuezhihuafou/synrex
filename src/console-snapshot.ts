import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { DiagnosticTrace, summarizeDiagnosticTrace } from "./diagnostic-trace.js";
import { summarizeConsoleObservability } from "./console-observability.js";
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
  tasks: Array<{ id: string; nodeId: string; workspaceId: string; runId: string | null; createdAt: string; status: string; lastUpdatedAt?: string }>;
  activeTaskUnits: string[] | null;
  memory: { episodes: number; successful: number; candidates: number; promoted: number };
  diagnostics: {
    count: number;
    observability: ReturnType<typeof summarizeConsoleObservability>;
    requests: ReturnType<typeof summarizeDiagnosticTrace>["requests"];
    events: ReturnType<DiagnosticTrace["read"]>;
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
          runId: row.run_id, createdAt: row.created_at, ...localTaskStatus(row.run_id),
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
  const events = new DiagnosticTrace(stateDir).read({ minutes: 24 * 60, limit: 20000 });
  const requests = summarizeDiagnosticTrace(events).requests.slice(-40).reverse();
  return {
    generatedAt: new Date().toISOString(),
    service: { status: "online", release, diagnosticsBoundBytes: 2 * 1024 * 1024 },
    nodes, workflows, tasks, memory, activeTaskUnits: readActiveTaskUnits(),
    diagnostics: { count: events.length, observability: summarizeConsoleObservability(events), requests, events: events.slice(-40).reverse() },
  };
}
