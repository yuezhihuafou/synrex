/** Conservative worktree lifecycle view and GC. A workflow, not a chat, owns the workspace. */
import { statSync } from "node:fs";
import { readFile, readlink, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Result } from "better-result";
import type { ServerConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { cleanupManagedWorktrees } from "./git-worktrees.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { closeWorkspaceStoreResult, createWorkspaceStoreResult, type WorkspaceStore } from "./workspace-store.js";
import { isPathInsideRoot } from "./roots.js";
import { withWorkspaceLifecycleLock } from "./workspace-lifecycle-lock.js";
const execFileAsync = promisify(execFile);

export type WorkspaceLifecycleState = "active" | "protected" | "idle" | "reclaimable" | "archived";
export interface WorktreeLifecycleRow {
  workspaceId: string; path: string; sourceRoot: string | null;
  status: WorkspaceLifecycleState; reason: string; lastUsedAt: string;
  workflows: number; leases: number; ageDays: number;
  /** Directory entry metadata, not recursive usage. Full disk usage is measured on demand. */
  diskBytes: number | null;
}

type SessionRow = {
  id: string; root: string; source_root: string | null; status: string;
  last_used_at: string;
};

export function classifyWorkspaceLifecycle(input: {
  session: SessionRow; workflowStatuses: string[]; activeLeases: number;
  now?: Date; retentionDays?: number;
}): Pick<WorktreeLifecycleRow, "status" | "reason" | "ageDays"> {
  const ageDays = Math.max(0, (Number(input.now ?? new Date()) - Date.parse(input.session.last_used_at)) / 86_400_000);
  if (input.session.status === "pruned") return { status: "archived", reason: "workspace_pruned_recoverable", ageDays };
  if (input.session.status !== "active") return { status: "protected", reason: "workspace_inactive", ageDays };
  if (input.activeLeases > 0) return { status: "active", reason: "active_lease", ageDays };
  if (input.workflowStatuses.some(s => s === "active" || s === "blocked")) {
    return { status: "active", reason: "unfinished_workflow", ageDays };
  }
  if (!input.workflowStatuses.length) return { status: "protected", reason: "unknown_workflow_owner", ageDays };
  if (input.workflowStatuses.some(s => s !== "completed" && s !== "cancelled")) {
    return { status: "protected", reason: "unrecognized_workflow_state", ageDays };
  }
  if (!Number.isFinite(ageDays) || ageDays < (input.retentionDays ?? 3)) {
    return { status: "idle", reason: "retention_period", ageDays };
  }
  // Eligibility is NOT permission to delete. The Git/prune layer still checks
  // dirty, ignored/untracked files, unintegrated commits and live cwd owners.
  return { status: "reclaimable", reason: "awaiting_git_safety_check", ageDays };
}

/** Lightweight read-only Console overview: never recursively scan or launch Git in the 15s collector. */
export function listWorktreeLifecycle(stateDir: string, now = new Date()): WorktreeLifecycleRow[] {
  const file = databasePath(stateDir);
  try { statSync(file); } catch { return []; }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let workflows: CodingWorkflowStore | undefined;
  try {
    workflows = new CodingWorkflowStore(stateDir);
    const sessions = db.prepare(`select id, root, source_root, status, last_used_at
      from workspace_sessions where mode = 'worktree' and managed = 'true'
      order by last_used_at desc limit 300`).all() as SessionRow[];
    return sessions.map(session => {
      const statuses = workflows!.statusesForRoot(session.root);
      const leases = workflows!.activeLeaseCount(session.id, now);
      const classified = classifyWorkspaceLifecycle({ session, workflowStatuses: statuses,
        activeLeases: leases, now });
      return { workspaceId: session.id, path: session.root, sourceRoot: session.source_root,
        ...classified, lastUsedAt: session.last_used_at, workflows: statuses.length,
        leases, diskBytes: null };
    });
  } finally { workflows?.close(); db.close(); }
}

/** Expensive detail checks run only for a selected worktree, never in the 15s snapshot loop. */
export async function inspectWorktreeLifecycle(stateDir: string, workspaceId: string) {
  const row = listWorktreeLifecycle(stateDir).find(item => item.workspaceId === workspaceId);
  if (!row) return undefined;
  let diskBytes: number | null = null;
  try {
    const { stdout } = await execFileAsync("du", ["-sk", "--", row.path], {
      encoding: "utf8", timeout: 4000, maxBuffer: 4_096,
    });
    const kilobytes = stdout.split(/\s+/)[0];
    const value = Number(kilobytes);
    if (Number.isSafeInteger(value) && value >= 0) diskBytes = value * 1024;
  } catch { /* unavailable disk metric; never infer an empty directory */ }

  const processes: Array<{ pid: number; name: string }> = [];
  let processScan = "unsupported";
  if (process.platform === "linux") {
    try {
      processScan = "best_effort";
      for (const name of await readdir("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        let cwd: string;
        try { cwd = await readlink(`/proc/${name}/cwd`); } catch { continue; }
        if (!isPathInsideRoot(cwd, row.path)) continue;
        let command = "unknown";
        try { command = (await readFile(`/proc/${name}/comm`, "utf8")).trim().slice(0, 80); } catch { /* process exited */ }
        processes.push({ pid: Number(name), name: command });
        if (processes.length >= 30) { processScan = "capped"; break; }
      }
    } catch { processScan = "unavailable"; }
  }
  return { ...row, diskBytes, processes, processScan };
}

/** Never use the legacy force-capable cleanup path for automatic reclamation. */
export async function pruneCompletedWorktrees(config: ServerConfig, now = new Date(), dryRun = true) {
  return withWorkspaceLifecycleLock(config.stateDir, () => pruneCompletedWorktreesLocked(config, now, dryRun));
}

async function pruneCompletedWorktreesLocked(config: ServerConfig, now: Date, dryRun: boolean) {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;
  const store = opened.value;
  const workflows = new CodingWorkflowStore(config.stateDir);
  const claimed = new Set<string>();
  try {
    const guardedStore = new Proxy(store, {
      get(target, property) {
        if (property === "listStaleManagedWorktrees") {
          return (before: Date): ReturnType<WorkspaceStore["listStaleManagedWorktrees"]> => {
            const stale = target.listStaleManagedWorktrees(before);
            if (stale.isErr()) return stale;
            const eligible = [] as typeof stale.value;
            for (const session of stale.value) {
              const classified = classifyWorkspaceLifecycle({
                session: { id: session.id, root: session.root, source_root: session.sourceRoot ?? null,
                  status: session.status, last_used_at: session.lastUsedAt },
                workflowStatuses: workflows.statusesForRoot(session.root),
                activeLeases: workflows.activeLeaseCount(session.id, now), now,
              });
              if (classified.status !== "reclaimable") continue;
              if (!dryRun) {
                // Atomically prevent a resumed session from touching this tree
                // after the GC decision. If it was touched since our read,
                // leave it untouched and retry on a future collection.
                const claim = target.claimStaleForGc(session.id, session.lastUsedAt);
                if (claim.isErr()) return claim;
                if (!claim.value) continue;
                claimed.add(session.id);
              }
              eligible.push(session);
            }
            return Result.ok(eligible);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return await cleanupManagedWorktrees({
      store: guardedStore, worktreeRoot: config.worktreeRoot,
      allowedRoots: config.allowedRoots,
      staleBefore: new Date(Number(now) - 3 * 86_400_000),
      safeOnly: true, dryRun,
    });
  } finally {
    // Successful removals are 'pruned'; skipped/error candidates are still
    // 'inactive'. Restore those to active, never strand them inaccessible.
    for (const id of claimed) {
      const released = store.releaseGcClaim(id);
      if (released.isErr()) throw released.error;
    }
    workflows.close();
    const closed = closeWorkspaceStoreResult(store);
    if (closed.isErr()) throw closed.error;
  }
}
