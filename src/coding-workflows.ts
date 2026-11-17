import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, join } from "node:path";
import Database from "better-sqlite3";
import { assessGoal } from "./goal-continuity.js";

export type CodingWorkflowStatus = "active" | "blocked" | "completed" | "cancelled";

export interface CodingWorkflowCheckpoint {
  summary: string;
  phase: string;
  completedSteps: string[];
  nextSteps: string[];
  blockers: string[];
  checks: string[];
  taskIds: string[];
  /** Criterion references to observed verification events, not model-reported checks. */
  criterionEvidence?: Array<{ criterion: number; eventId: string }>;
  /** Explicitly associated Subagent handles; never infer unrelated agents. */
  agentIds?: string[];
  gitHead?: string;
  gitStatus?: string;
}

export interface WorkflowExecutionEvidence {
  eventId: string;
  workflowId: string;
  kind: "command" | "verification" | "edit";
  status: "working" | "running" | "input_required" | "completed" | "failed" | "cancelled" | "unknown";
  runId?: string;
  taskId?: string;
  sessionId?: number;
  exitCode?: number;
  command?: string;
  workingDirectory?: string;
  workspaceId?: string;
  nodeAlias?: string;
  source?: "exec_command" | "task_receipt" | "process_receipt" | "apply_patch" | "semantic_edit";
  verificationScope?: string[];
  fingerprint?: string;
  stale?: boolean;
  observedAt: string;
}

/** Hash the actual Git contents in scope (committed tree, dirty diff and untracked files).
 * Unlike HEAD/status alone this detects a second edit to an already-dirty file.
 * A scoped test does not expire when an unrelated file outside its scope changes.
 */
export function verificationFingerprint(root: string, scope: readonly string[]): string | undefined {
  const selected = scope.length ? scope : ["src", "test", "tests", "package.json", "pnpm-lock.yaml", "tsconfig.json"];
  const paths = [...selected];
  if (paths.length > 32 || paths.some(p => p.startsWith("/") || p.split("/").includes(".."))) return undefined;
  // Expand the targeted test/implementation files through relative imports.
  // This catches changes to shared helpers without invalidating every test
  // when an unrelated source file is modified. Unknown/oversized graphs fail
  // closed instead of incorrectly reusing the verification receipt.
  if (scope.length) {
    const seen = new Set(paths);
    const queue = paths.filter(p => /\.[cm]?[jt]sx?$/.test(p));
    while (queue.length) {
      if (seen.size > 128) return undefined;
      const file = queue.shift()!;
      const full = join(root, file);
      if (!existsSync(full)) continue;
      if (!lstatSync(full).isFile()) return undefined;
      const source = readFileSync(full);
      if (source.length > 1024 * 1024) return undefined;
      const imports = source.toString("utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)["'](\.[^"']+)["']/g);
      for (const match of imports) {
        const local = match[1]!;
        const base = relative(root, resolve(dirname(full), local));
        if (base.startsWith("..") || base.startsWith("/")) return undefined;
        const candidates = [base.replace(/\.[cm]?js$/, ".ts"), base.replace(/\.[cm]?js$/, ".tsx"),
          base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")];
        const target = candidates.find(p => existsSync(join(root, p)) && lstatSync(join(root, p)).isFile());
        if (!target) return undefined;
        if (!seen.has(target)) { seen.add(target); paths.push(target); queue.push(target); }
      }
    }
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    timeout: 3500, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const hash = createHash("sha256");
    for (const bytes of [git("ls-tree", "-r", "-z", "HEAD", "--", ...paths),
      git("diff", "--binary", "HEAD", "--", ...paths)]) hash.update(bytes);
    const untracked = git("ls-files", "-z", "--others", "--exclude-standard", "--", ...paths)
      .toString("utf8").split("\0").filter(Boolean);
    if (untracked.length > 128) return undefined;
    for (const file of untracked) {
      if (!lstatSync(join(root, file)).isFile()) return undefined;
      hash.update(file);
      const data = readFileSync(join(root, file));
      if (data.length > 2 * 1024 * 1024) return undefined;
      hash.update(data);
    }
    return hash.digest("hex");
  } catch { return undefined; }
}

export interface CodingWorkflow {
  workflowId: string;
  workspaceRoot: string;
  /** Stable session identity for cross-conversation recovery; optional for legacy records. */
  workspaceId?: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: CodingWorkflowStatus;
  revision: number;
  checkpoint: CodingWorkflowCheckpoint;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEvent {
  revision: number;
  status: CodingWorkflowStatus;
  checkpoint: CodingWorkflowCheckpoint;
  createdAt: string;
}

type DbRow = {
  workflow_id: string;
  workspace_root: string;
  workspace_session_id: string | null;
  title: string;
  goal: string;
  acceptance_json: string;
  constraints_json: string;
  status: CodingWorkflowStatus;
  revision: number;
  checkpoint_json: string;
  created_at: string;
  updated_at: string;
};

const EMPTY_CHECKPOINT: CodingWorkflowCheckpoint = {
  summary: "Not started",
  phase: "planning",
  completedSteps: [],
  nextSteps: [],
  blockers: [],
  checks: [],
  taskIds: [],
};

function fromRow(row: DbRow): CodingWorkflow {
  return {
    workflowId: row.workflow_id,
    workspaceRoot: row.workspace_root,
    ...(row.workspace_session_id ? { workspaceId: row.workspace_session_id } : {}),
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: JSON.parse(row.acceptance_json) as string[],
    constraints: JSON.parse(row.constraints_json) as string[],
    status: row.status,
    revision: row.revision,
    checkpoint: JSON.parse(row.checkpoint_json) as CodingWorkflowCheckpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Independent database deliberately avoids changing the production OAuth database's migration history. */
export class CodingWorkflowStore {
  private readonly db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const file = join(stateDir, "coding-workflows.sqlite");
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      create table if not exists coding_workflows (
        workflow_id text primary key,
        workspace_root text not null,
        create_key text,
        title text not null,
        goal text not null,
        acceptance_json text not null,
        constraints_json text not null,
        status text not null check (status in ('active', 'blocked', 'completed', 'cancelled')),
        revision integer not null,
        checkpoint_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists coding_workflows_workspace_idx
        on coding_workflows(workspace_root, updated_at desc);
      create table if not exists coding_workflow_events (
        workflow_id text not null references coding_workflows(workflow_id) on delete cascade,
        revision integer not null,
        status text not null,
        checkpoint_json text not null,
        created_at text not null,
        primary key (workflow_id, revision)
      );
    `);
    const columns = this.db.pragma("table_info(coding_workflows)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "create_key")) {
      this.db.exec("alter table coding_workflows add column create_key text");
    }
    if (!columns.some((column) => column.name === "workspace_session_id")) {
      this.db.exec("alter table coding_workflows add column workspace_session_id text");
    }
    this.db.exec(`create unique index if not exists coding_workflows_create_key_idx
      on coding_workflows(workspace_root, create_key) where create_key is not null`);
    this.db.exec(`create table if not exists coding_workspace_leases (
      lease_id text primary key, workspace_id text not null,
      expires_at text not null, created_at text not null
    );
    create index if not exists coding_workspace_leases_scope_idx
      on coding_workspace_leases(workspace_id, expires_at)`);
    this.db.exec(`
      create table if not exists coding_workflow_evidence (
        event_id text primary key,
        workflow_id text not null references coding_workflows(workflow_id),
        event_key text not null,
        kind text not null,
        status text not null,
        run_id text,
        task_id text,
        session_id integer,
        exit_code integer,
        command text,
        working_directory text,
        workspace_id text,
        node_alias text,
        source text,
        scope_json text,
        fingerprint text,
        observed_at text not null,
        unique(workflow_id, event_key)
      );
      create index if not exists coding_workflow_evidence_recent_idx
        on coding_workflow_evidence(workflow_id, observed_at);
      create table if not exists coding_workflow_bindings (
        workspace_id text not null,
        conversation_scope text not null,
        workflow_id text not null references coding_workflows(workflow_id),
        expires_at text not null,
        primary key (workspace_id, conversation_scope)
      );
    `);
    const evidenceColumns = this.db.pragma("table_info(coding_workflow_evidence)") as Array<{ name: string }>;
    for (const [column, type] of [["command", "text"], ["source", "text"], ["scope_json", "text"], ["fingerprint", "text"], ["session_id", "integer"], ["working_directory", "text"], ["workspace_id", "text"], ["node_alias", "text"]]) {
      if (!evidenceColumns.some(c => c.name === column)) {
        this.db.exec(`alter table coding_workflow_evidence add column ${column} ${type}`);
      }
    }
    this.db.exec(`create index if not exists coding_workflow_evidence_state_idx
      on coding_workflow_evidence(workflow_id, status)`);
    this.db.exec(`create index if not exists coding_workflow_evidence_task_idx
      on coding_workflow_evidence(workflow_id, task_id)`);
  }

  close(): void {
    this.db.close();
  }

  create(root: string, input: {
    title: string;
    goal: string;
    acceptanceCriteria: string[];
    constraints: string[];
    /** Stable caller-provided request ID to deduplicate a retried creation. */
    requestKey?: string;
    workspaceId?: string;
  }): CodingWorkflow {
    const workspaceRoot = resolve(root);
    if (input.requestKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestKey)) {
      throw new Error("Invalid workflow requestKey");
    }
    return this.db.transaction(() => {
      if (input.requestKey) {
        const existing = this.db.prepare(`select * from coding_workflows
          where workspace_root = ? and create_key = ?`).get(workspaceRoot, input.requestKey) as DbRow | undefined;
        if (existing) {
          const record = fromRow(existing);
          if (record.goal !== input.goal || record.title !== input.title
            || JSON.stringify(record.acceptanceCriteria) !== JSON.stringify(input.acceptanceCriteria)
            || JSON.stringify(record.constraints) !== JSON.stringify(input.constraints)) {
            throw new Error("Workflow requestKey reused for a different goal or constraints");
          }
          if (input.workspaceId && record.workspaceId && input.workspaceId !== record.workspaceId) {
            throw new Error("Workflow requestKey already belongs to another workspace session");
          }
          return record;
        }
      }
      const workflowId = `wf_${randomBytes(12).toString("hex")}`;
      const now = new Date().toISOString();
      this.db.prepare(`insert into coding_workflows
        (workflow_id, workspace_root, workspace_session_id, create_key, title, goal, acceptance_json, constraints_json,
         status, revision, checkpoint_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`)
        .run(workflowId, workspaceRoot, input.workspaceId ?? null, input.requestKey ?? null, input.title, input.goal,
          JSON.stringify(input.acceptanceCriteria), JSON.stringify(input.constraints),
          JSON.stringify(EMPTY_CHECKPOINT), now, now);
      return this.getRequired(workflowId, workspaceRoot);
    }).immediate();
  }

  get(workflowId: string, root: string): CodingWorkflow | undefined {
    const row = this.db.prepare(`select * from coding_workflows
      where workflow_id = ? and workspace_root = ?`)
      .get(workflowId, resolve(root)) as DbRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Lookup is by unguessable workflow ID; callers must validate the returned workspace session. */
  getById(workflowId: string): CodingWorkflow | undefined {
    if (!/^wf_[a-f0-9]{24}$/.test(workflowId)) throw new Error("Invalid workflow ID");
    const row = this.db.prepare("select * from coding_workflows where workflow_id = ?")
      .get(workflowId) as DbRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Used by the worktree GC to exclude unfinished workflows from reclamation. */
  statusesForRoot(root: string): CodingWorkflowStatus[] {
    return (this.db.prepare("select status from coding_workflows where workspace_root = ?")
      .all(resolve(root)) as Array<{ status: CodingWorkflowStatus }>).map(row => row.status);
  }

  /** Fenced, expiring ownership for multi-conversation work; no implicit indefinite locks. */
  lease(workspaceId: string, leaseId?: string, ttlMs = 30 * 60_000): { leaseId: string; expiresAt: string } {
    if (!/^ws_[a-zA-Z0-9_-]{5,100}$/.test(workspaceId)) throw new Error("Invalid workspaceId");
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new Error("Workspace lease must last between 1 and 60 minutes");
    }
    const id = leaseId ?? `wl_${randomBytes(16).toString("hex")}`;
    if (!/^wl_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid lease ID");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const now = new Date().toISOString();
    if (leaseId) {
      const updated = this.db.prepare(`update coding_workspace_leases set expires_at = ?
        where lease_id = ? and workspace_id = ? and expires_at > ?`)
        .run(expiresAt, id, workspaceId, now);
      if (!updated.changes) throw new Error("Workspace lease expired or does not belong to this session");
    } else {
      this.db.prepare(`insert into coding_workspace_leases
        (lease_id, workspace_id, expires_at, created_at) values (?, ?, ?, ?)`)
        .run(id, workspaceId, expiresAt, now);
    }
    return { leaseId: id, expiresAt };
  }

  releaseLease(workspaceId: string, leaseId: string): boolean {
    if (!/^wl_[a-f0-9]{32}$/.test(leaseId)) throw new Error("Invalid lease ID");
    return this.db.prepare(`delete from coding_workspace_leases where workspace_id = ? and lease_id = ?`)
      .run(workspaceId, leaseId).changes > 0;
  }

  activeLeaseCount(workspaceId: string, now = new Date()): number {
    return (this.db.prepare(`select count(*) as n from coding_workspace_leases
      where workspace_id = ? and expires_at > ?`).get(workspaceId, now.toISOString()) as { n: number }).n;
  }

  getRequired(workflowId: string, root: string): CodingWorkflow {
    const record = this.get(workflowId, root);
    if (!record) throw new Error(`Coding workflow ${workflowId} was not found in this workspace.`);
    return record;
  }

  list(root: string, options: { includeCompleted?: boolean; limit?: number } = {}): CodingWorkflow[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
    const rows = this.db.prepare(`select * from coding_workflows
      where workspace_root = ? ${options.includeCompleted ? "" : "and status in ('active', 'blocked')"}
      order by updated_at desc, workflow_id desc limit ?`)
      .all(resolve(root), limit) as DbRow[];
    return rows.map(fromRow);
  }

  history(workflowId: string, root: string, limit = 10): WorkflowEvent[] {
    this.getRequired(workflowId, root);
    const rows = this.db.prepare(`select revision, status, checkpoint_json, created_at
      from coding_workflow_events where workflow_id = ? order by revision desc limit ?`)
      .all(workflowId, Math.min(Math.max(limit, 1), 25)) as Array<{
        revision: number; status: CodingWorkflowStatus; checkpoint_json: string; created_at: string;
      }>;
    return rows.map((row) => ({
      revision: row.revision,
      status: row.status,
      checkpoint: JSON.parse(row.checkpoint_json) as CodingWorkflowCheckpoint,
      createdAt: row.created_at,
    }));
  }

  /** Bind only when the caller explicitly opened/resumed a workflow in this conversation. */
  bind(workflowId: string, root: string, workspaceId: string, scope: string): void {
    const workflow = this.getRequired(workflowId, root);
    if (workflow.workspaceId && workflow.workspaceId !== workspaceId) {
      throw new Error("Workflow belongs to another workspace session");
    }
    if (!scope || scope.length > 4096) throw new Error("Invalid conversation scope");
    const scopeHash = createHash("sha256").update(scope).digest("hex");
    this.db.prepare(`insert into coding_workflow_bindings
      (workspace_id, conversation_scope, workflow_id, expires_at) values (?, ?, ?, ?)
      on conflict(workspace_id, conversation_scope) do update
      set workflow_id=excluded.workflow_id, expires_at=excluded.expires_at`)
      .run(workspaceId, scopeHash, workflowId, new Date(Date.now() + 12 * 60 * 60_000).toISOString());
  }

  selected(root: string, workspaceId: string, scope?: string, explicitId?: string): CodingWorkflow | undefined {
    if (explicitId) {
      const workflow = this.getRequired(explicitId, root);
      if (workflow.workspaceId && workflow.workspaceId !== workspaceId) {
        throw new Error("Workflow belongs to another workspace session");
      }
      return workflow;
    }
    if (!scope) return undefined;
    const scopeHash = createHash("sha256").update(scope).digest("hex");
    const row = this.db.prepare(`select workflow_id from coding_workflow_bindings
      where workspace_id=? and conversation_scope=? and expires_at>?`)
      .get(workspaceId, scopeHash, new Date().toISOString()) as { workflow_id: string } | undefined;
    if (!row) return undefined;
    // Sliding expiry, but do not force a SQLite write on every routine tool call.
    this.db.prepare(`update coding_workflow_bindings set expires_at=?
      where workspace_id=? and conversation_scope=? and expires_at<?`)
      .run(new Date(Date.now() + 12 * 60 * 60_000).toISOString(), workspaceId, scopeHash,
        new Date(Date.now() + 60 * 60_000).toISOString());
    return this.getRequired(row.workflow_id, root);
  }

  evidence(workflowId: string, root: string, proposedEventIds: readonly string[] = []): WorkflowExecutionEvidence[] {
    const workflow = this.getRequired(workflowId, root);
    const refs = [...new Set([
      ...(workflow.checkpoint.criterionEvidence ?? []).map(c => c.eventId), ...proposedEventIds,
    ])].slice(0, 80);
    const checkpointTaskIds = [...new Set(workflow.checkpoint.taskIds)].slice(0, 40);
    const columns = `event_id, workflow_id, kind, status, run_id, task_id, session_id, exit_code,
      command, source, scope_json, fingerprint, working_directory, workspace_id, node_alias, observed_at`;
    const unresolvedCount = (this.db.prepare(`select count(*) as n from coding_workflow_evidence
      where workflow_id=? and status in ('working','running','input_required','unknown')`)
      .get(workflowId) as { n: number }).n;
    const rows = [
      ...this.db.prepare(`select ${columns} from coding_workflow_evidence
        where workflow_id=? order by rowid desc limit 64`).all(workflowId),
      ...this.db.prepare(`select ${columns} from coding_workflow_evidence
        where workflow_id=? and status in ('working','running','input_required','unknown')
        order by rowid desc limit 256`).all(workflowId),
      ...(refs.length ? this.db.prepare(`select ${columns} from coding_workflow_evidence
        where workflow_id=? and event_id in (${refs.map(() => "?").join(",")})`)
        .all(workflowId, ...refs) : []),
      ...(checkpointTaskIds.length ? this.db.prepare(`select ${columns} from coding_workflow_evidence
        where workflow_id=? and task_id in (${checkpointTaskIds.map(() => "?").join(",")})
        order by rowid desc limit 80`).all(workflowId, ...checkpointTaskIds) : []),
    ] as Array<{
        event_id: string; workflow_id: string; kind: WorkflowExecutionEvidence["kind"];
        status: WorkflowExecutionEvidence["status"]; run_id: string | null;
        task_id: string | null; session_id: number | null; exit_code: number | null; observed_at: string;
        command: string | null; source: WorkflowExecutionEvidence["source"] | null;
        scope_json: string | null; fingerprint: string | null;
        working_directory: string | null; workspace_id: string | null; node_alias: string | null;
      }>;
    const unique = new Map(rows.map(row => [row.event_id, row]));
    const cache = new Map<string, string | undefined>();
    const claims = new Set(refs);
    const evidence = [...unique.values()].map((row) => {
      const scope = row.scope_json ? JSON.parse(row.scope_json) as string[] : undefined;
      const key = JSON.stringify(scope ?? []);
      if (row.fingerprint && claims.has(row.event_id) && !cache.has(key)) {
        cache.set(key, verificationFingerprint(root, scope ?? []));
      }
      return ({
      eventId: row.event_id, workflowId: row.workflow_id, kind: row.kind,
      status: (["working", "running"].includes(row.status)
        && Date.now() - Date.parse(row.observed_at) > 24 * 60 * 60_000
        ? "unknown" : row.status), observedAt: row.observed_at,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.command ? { command: row.command } : {}),
      ...(row.working_directory ? { workingDirectory: row.working_directory } : {}),
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(row.node_alias ? { nodeAlias: row.node_alias } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(scope ? { verificationScope: scope } : {}),
      ...(row.fingerprint ? { fingerprint: row.fingerprint,
        ...(claims.has(row.event_id) ? { stale: cache.get(key) !== row.fingerprint } : {}) } : {}),
    });
    });
    if (unresolvedCount > 256) evidence.push({
      eventId: "unresolved-overflow", workflowId, kind: "command", status: "unknown",
      runId: `unresolved-overflow-${unresolvedCount}`, observedAt: new Date().toISOString(),
    });
    return evidence;
  }

  /** Append/upsert observation without incrementing workflow checkpoint revision. */
  observe(root: string, workflowId: string, input: {
    eventKey: string;
    kind: WorkflowExecutionEvidence["kind"];
    status: WorkflowExecutionEvidence["status"];
    runId?: string;
    taskId?: string;
    sessionId?: number;
    exitCode?: number;
    command?: string;
    workingDirectory?: string;
    workspaceId?: string;
    nodeAlias?: string;
    source?: WorkflowExecutionEvidence["source"];
    verificationScope?: string[];
    fingerprint?: string;
  }): WorkflowExecutionEvidence {
    this.getRequired(workflowId, root);
    if (!input.eventKey || input.eventKey.length > 250) throw new Error("Invalid evidence key");
    this.db.prepare(`insert into coding_workflow_evidence
      (event_id, workflow_id, event_key, kind, status, run_id, task_id, session_id, exit_code,
       command, source, scope_json, fingerprint, working_directory, workspace_id, node_alias, observed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(workflow_id, event_key) do update set
        status=case when coding_workflow_evidence.status in ('completed','failed','cancelled')
          then coding_workflow_evidence.status else excluded.status end,
        task_id=coalesce(excluded.task_id, coding_workflow_evidence.task_id),
        session_id=coalesce(excluded.session_id, coding_workflow_evidence.session_id),
        exit_code=coalesce(coding_workflow_evidence.exit_code, excluded.exit_code),
        command=coalesce(coding_workflow_evidence.command, excluded.command),
        working_directory=coalesce(coding_workflow_evidence.working_directory, excluded.working_directory),
        workspace_id=coalesce(coding_workflow_evidence.workspace_id, excluded.workspace_id),
        node_alias=coalesce(coding_workflow_evidence.node_alias, excluded.node_alias),
        source=coalesce(coding_workflow_evidence.source, excluded.source),
        scope_json=coalesce(coding_workflow_evidence.scope_json, excluded.scope_json),
        fingerprint=coalesce(coding_workflow_evidence.fingerprint, excluded.fingerprint),
        observed_at=excluded.observed_at`)
      .run("we_" + randomBytes(12).toString("hex"), workflowId, input.eventKey,
        input.kind, input.status, input.runId ?? null, input.taskId ?? null, input.sessionId ?? null,
        input.exitCode ?? null, input.command ?? null, input.source ?? null,
        input.verificationScope ? JSON.stringify(input.verificationScope) : null,
        input.fingerprint ?? null, input.workingDirectory ?? null, input.workspaceId ?? null,
        input.nodeAlias ?? null, new Date().toISOString());
    const row = this.db.prepare(`select event_id, kind, status, run_id, task_id, session_id,
      exit_code, command, source, scope_json, fingerprint,
      working_directory, workspace_id, node_alias, observed_at from coding_workflow_evidence
      where workflow_id=? and event_key=?`).get(workflowId, input.eventKey) as {
        event_id: string; kind: WorkflowExecutionEvidence["kind"];
        status: WorkflowExecutionEvidence["status"]; run_id: string | null;
        task_id: string | null; session_id: number | null; exit_code: number | null; observed_at: string;
        command: string | null; source: WorkflowExecutionEvidence["source"] | null;
        scope_json: string | null; fingerprint: string | null;
        working_directory: string | null; workspace_id: string | null; node_alias: string | null;
      };
    // Capture at the original exec_command observation, even if the test is
    // still running. Capturing only at task_get completion would incorrectly
    // validate code edited WHILE an old test was running. Legacy records
    // first seen at task_get remain unverified rather than inventing a start
    // fingerprint from the already-modified tree.
    if (row.kind === "verification" && input.source === "exec_command"
      && row.source === "exec_command" && row.command && !row.fingerprint) {
      const scope = row.scope_json ? JSON.parse(row.scope_json) as string[] : [];
      const fingerprint = verificationFingerprint(root, scope);
      if (fingerprint) {
        this.db.prepare(`update coding_workflow_evidence set fingerprint=?
          where workflow_id=? and event_id=? and fingerprint is null`)
          .run(fingerprint, workflowId, row.event_id);
        row.fingerprint = fingerprint;
      }
    }
    return {
      eventId: row.event_id, workflowId, kind: row.kind, status: row.status,
      observedAt: row.observed_at,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.command ? { command: row.command } : {}),
      ...(row.working_directory ? { workingDirectory: row.working_directory } : {}),
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(row.node_alias ? { nodeAlias: row.node_alias } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.scope_json ? { verificationScope: JSON.parse(row.scope_json) as string[] } : {}),
      ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    };
  }

  checkpoint(root: string, input: {
    workflowId: string;
    expectedRevision: number;
    status: CodingWorkflowStatus;
    checkpoint: CodingWorkflowCheckpoint;
  }): CodingWorkflow {
    const workspaceRoot = resolve(root);
    return this.db.transaction(() => {
      const current = this.getRequired(input.workflowId, workspaceRoot);
      if (current.revision === input.expectedRevision + 1
        && current.status === input.status
        && JSON.stringify(current.checkpoint) === JSON.stringify(input.checkpoint)) {
        // A response may have been lost after commit; return the committed state
        // without appending another event or advancing the revision.
        return current;
      }
      if (current.revision !== input.expectedRevision) {
        throw new Error(`Workflow revision conflict: expected ${input.expectedRevision}, current ${current.revision}. Call workflow_status before updating.`);
      }
      if (current.status === "completed" || current.status === "cancelled") {
        throw new Error(`Workflow ${input.workflowId} is ${current.status} and cannot be changed.`);
      }
      if (input.status === "completed" && input.checkpoint.checks.length === 0) {
        throw new Error("Cannot mark workflow completed without a recorded verification check. A checkpoint or partial result is not proof that acceptance criteria passed.");
      }
      if (input.status === "completed" && (input.checkpoint.nextSteps.length || input.checkpoint.blockers.length || input.checkpoint.taskIds.length)) {
        throw new Error("Cannot complete workflow with pending steps, blockers, or unresolved task IDs. Verify the original goal first.");
      }
      if (input.status === "completed") {
        const goal = assessGoal({
          ...current, status: input.status, checkpoint: input.checkpoint,
        }, this.evidence(input.workflowId, workspaceRoot,
          (input.checkpoint.criterionEvidence ?? []).map(c => c.eventId)));
        if (goal.status !== "satisfied") {
          throw new Error("Goal Finish Gate: acceptance is not independently verified (" + goal.status
            + "); remaining=" + goal.remaining.join("; ") + ", pending=" + goal.pendingTaskIds.join(","));
        }
      }
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      const payload = JSON.stringify(input.checkpoint);
      const changed = this.db.prepare(`update coding_workflows
        set status = ?, revision = ?, checkpoint_json = ?, updated_at = ?
        where workflow_id = ? and workspace_root = ? and revision = ?`)
        .run(input.status, revision, payload, now, input.workflowId, workspaceRoot, input.expectedRevision);
      if (changed.changes !== 1) throw new Error("Workflow revision changed during checkpoint.");
      this.db.prepare(`insert into coding_workflow_events
        (workflow_id, revision, status, checkpoint_json, created_at) values (?, ?, ?, ?, ?)`)
        .run(input.workflowId, revision, input.status, payload, now);
      // Keep the recent 512 receipts and all currently referenced acceptance
      // evidence. Expired, unreferenced terminal observations already have
      // their primary run logs; they need not grow this auxiliary index forever.
      const retained = [...new Set((input.checkpoint.criterionEvidence ?? []).map(c => c.eventId))];
      this.db.prepare(`delete from coding_workflow_evidence
        where workflow_id=? and status in ('completed','failed','cancelled')
          and observed_at<? and rowid not in
            (select rowid from coding_workflow_evidence where workflow_id=? order by rowid desc limit 512)
          ${retained.length ? `and event_id not in (${retained.map(() => "?").join(",")})` : ""}`)
        .run(input.workflowId, new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString(),
          input.workflowId, ...retained);
      return this.getRequired(input.workflowId, workspaceRoot);
    }).immediate();
  }
}

export function withCodingWorkflowStore<T>(stateDir: string, operation: (store: CodingWorkflowStore) => T): T {
  const store = new CodingWorkflowStore(stateDir);
  try { return operation(store); } finally { store.close(); }
}
