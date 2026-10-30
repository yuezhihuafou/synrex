import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";

export type CodingWorkflowStatus = "active" | "blocked" | "completed" | "cancelled";

export interface CodingWorkflowCheckpoint {
  summary: string;
  phase: string;
  completedSteps: string[];
  nextSteps: string[];
  blockers: string[];
  checks: string[];
  taskIds: string[];
  /** Explicitly associated Subagent handles; never infer unrelated agents. */
  agentIds?: string[];
  gitHead?: string;
  gitStatus?: string;
}

export interface CodingWorkflow {
  workflowId: string;
  workspaceRoot: string;
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
    this.db.exec(`create unique index if not exists coding_workflows_create_key_idx
      on coding_workflows(workspace_root, create_key) where create_key is not null`);
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
          return record;
        }
      }
      const workflowId = `wf_${randomBytes(12).toString("hex")}`;
      const now = new Date().toISOString();
      this.db.prepare(`insert into coding_workflows
        (workflow_id, workspace_root, create_key, title, goal, acceptance_json, constraints_json,
         status, revision, checkpoint_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`)
        .run(workflowId, workspaceRoot, input.requestKey ?? null, input.title, input.goal,
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
      return this.getRequired(input.workflowId, workspaceRoot);
    }).immediate();
  }
}

export function withCodingWorkflowStore<T>(stateDir: string, operation: (store: CodingWorkflowStore) => T): T {
  const store = new CodingWorkflowStore(stateDir);
  try { return operation(store); } finally { store.close(); }
}
