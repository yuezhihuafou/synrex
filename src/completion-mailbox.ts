import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DurableTaskView } from "./durable-task-model.js";

const TASK_ID = /^task_(?:[0-9a-f]{16}|[0-9a-f-]{36})$/i;
const RUN_ID = /^run_[a-zA-Z0-9_-]{8,64}$/;
const REDELIVERY_AFTER_MS = 120_000;
const RETENTION_MS = 48 * 60 * 60_000;
const MAX_DELIVERIES = 3;
const MAX_CANDIDATES = 8;
const MAX_PER_RESPONSE = 2;

type MailboxRow = {
  task_id: string;
  workspace_id: string;
  scope_key: string;
  created_at: number;
  delivered_at: number | null;
  attempts: number;
  acknowledged_at: number | null;
};

export interface MailboxEvent {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  runId?: string;
  exitCode?: number | null;
  revision: string;
}

export function mailboxScope(conversationScopeId: string | undefined): string {
  if (!conversationScopeId) return "workspace-only";
  // Never persist raw conversation/session IDs in the mailbox database.
  return "session-" + createHash("sha256").update(conversationScopeId).digest("hex").slice(0, 32);
}

function isTerminal(view: DurableTaskView): view is DurableTaskView & {
  status: MailboxEvent["status"];
} {
  return view.status === "completed" || view.status === "failed" || view.status === "cancelled";
}

/** Durable workspace- and (when available) conversation-scoped event receipts.
 * Opening a small local connection per operation avoids coupling a server
 * restart, MCP session, or tooling adapter to a long-lived database handle.
 */
export class CompletionMailbox {
  constructor(private readonly stateDir: string) {}

  register(workspaceId: string, scope: string, taskId: string): void {
    if (!TASK_ID.test(taskId)) return;
    const now = Date.now();
    this.withDb((db) => {
      db.prepare("DELETE FROM mailbox_tasks WHERE created_at < ?").run(now - RETENTION_MS);
      db.prepare(`
        INSERT OR IGNORE INTO mailbox_tasks
          (task_id, workspace_id, scope_key, created_at, delivered_at, attempts, acknowledged_at)
        VALUES (?, ?, ?, ?, NULL, 0, NULL)
      `).run(taskId, workspaceId, scope, now);
    });
  }

  acknowledge(workspaceId: string, scope: string, taskId: string): void {
    if (!TASK_ID.test(taskId)) return;
    if (!existsSync(join(this.stateDir, "completion-mailbox.sqlite"))) return;
    this.withDb((db) => db.prepare(`
      UPDATE mailbox_tasks SET acknowledged_at = ?
      WHERE task_id = ? AND workspace_id = ? AND scope_key = ?
    `).run(Date.now(), taskId, workspaceId, scope));
  }

  /** Only read registered tasks; never scan unrelated historical job logs.
   * Changes to task status are reported only after verifying the durable state
   * with the execution peer. A claim is at-least-once, not exactly-once:
   * dropped host responses can be redelivered after a bounded cooldown.
   */
  async collect(
    workspaceId: string,
    scope: string,
    lookup: (taskId: string) => Promise<DurableTaskView>,
  ): Promise<MailboxEvent[]> {
    if (!existsSync(join(this.stateDir, "completion-mailbox.sqlite"))) return [];
    const now = Date.now();
    const candidates = this.withDb((db) => db.prepare(`
      SELECT * FROM mailbox_tasks
      WHERE workspace_id = ? AND scope_key = ? AND acknowledged_at IS NULL
        AND created_at >= ?
        AND attempts < ?
        AND (delivered_at IS NULL OR delivered_at <= ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(workspaceId, scope, now - RETENTION_MS, MAX_DELIVERIES, now - REDELIVERY_AFTER_MS, MAX_CANDIDATES) as MailboxRow[]);
    const result: MailboxEvent[] = [];
    for (const row of candidates) {
      if (result.length >= MAX_PER_RESPONSE) break;
      let state: DurableTaskView;
      try {
        state = await lookup(row.task_id);
      } catch {
        // Absent or remote tasks are never claimed as completed. The relevant
        // peer can still expose the real result through an explicit task_get.
        continue;
      }
      if (!isTerminal(state) || state.taskId !== row.task_id) continue;
      const claimed = this.withDb((db) => db.prepare(`
        UPDATE mailbox_tasks
          SET delivered_at = ?, attempts = attempts + 1
        WHERE task_id = ? AND workspace_id = ? AND scope_key = ?
          AND acknowledged_at IS NULL AND attempts < ?
          AND (delivered_at IS NULL OR delivered_at <= ?)
      `).run(now, row.task_id, workspaceId, scope, MAX_DELIVERIES, now - REDELIVERY_AFTER_MS));
      if (claimed.changes !== 1) continue;
      result.push({
        taskId: row.task_id,
        status: state.status,
        ...(RUN_ID.test(state.runId) ? { runId: state.runId } : {}),
        ...(typeof state.result?.exitCode === "number" || state.result?.exitCode === null
          ? { exitCode: state.result.exitCode } : {}),
        revision: state.revision,
      });
    }
    return result;
  }

  /** Return only trusted status identifiers. Never quote arbitrary stdout,
   * error messages, or task commands into a model-facing notification. */
  static format(events: readonly MailboxEvent[]): string {
    const lines = events.slice(0, MAX_PER_RESPONSE).map((event) => (
      `task=${event.taskId} status=${event.status}`
      + (event.runId ? ` run=${event.runId}` : "")
      + (event.exitCode !== undefined ? ` exit=${event.exitCode}` : "")
      + ` rev=${event.revision}`
    ));
    return "[Synrex Completion Mailbox]\n"
      + lines.join("\n")
      + "\nA background task changed state. Inspect its saved result with task_get "
      + "(or exec_command devspace-task get <taskId>) before dependent work. "
      + "This notification does not automatically validate the task's objective.";
  }

  private withDb<T>(action: (db: Database.Database) => T): T {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const file = join(this.stateDir, "completion-mailbox.sqlite");
    const db = new Database(file);
    try {
      chmodSync(file, 0o600);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 2000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_tasks (
          task_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          acknowledged_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS mailbox_delivery_scope
          ON mailbox_tasks(workspace_id, scope_key, acknowledged_at, created_at);
      `);
      return action(db);
    } finally {
      db.close();
    }
  }
}

/** Adds a separate content block; leaves structuredContent and the original
 * result unchanged. No new tool, no callback permission, no model side effects.
 */
export function appendMailboxEvents<T extends Record<string, unknown>>(
  response: T,
  events: readonly MailboxEvent[],
): T {
  if (!events.length || response.isError === true || !Array.isArray(response.content)) return response;
  return {
    ...response,
    content: [
      ...response.content,
      { type: "text", text: CompletionMailbox.format(events) },
    ],
  };
}
