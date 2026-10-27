import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccessDeniedError, assertAllowedPath, isPathInsideRoot } from "./roots.js";

/** The same one-owner directory registry used by the MCP WorkspaceRegistry. */
export interface ManagedWorktreeAuthorization {
  stateDir: string;
  worktreeRoot: string;
}

function canonical(path: string): string {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

/**
 * Agent CLI/daemon permission mirrors the WorkspaceRegistry contract:
 * ordinary allowed roots OR an exact, active, registered managed worktree
 * whose source repository is within allowedRoots.
 *
 * Merely living under worktreeRoot is NOT enough. This prevents an injected
 * DEVSPACE_WORKSPACE_ROOT or forged workspaceId from escaping project policy.
 * The owner database is opened strictly read-only; no sessions are created.
 */
export function authorizeAgentWorkspaceRoot(input: {
  workspaceRoot: string;
  workspaceId: string | undefined;
  allowedRoots: readonly string[];
  managedWorktrees?: ManagedWorktreeAuthorization;
}): string {
  const root = canonical(input.workspaceRoot);
  const roots = input.allowedRoots.map(canonical);
  if (!input.workspaceId) return root; // Unscoped local CLI behavior is unchanged.

  try { return assertAllowedPath(root, roots); }
  catch (cause) {
    const policy = input.managedWorktrees;
    if (!policy || !isPathInsideRoot(root, canonical(policy.worktreeRoot))) throw cause;
    try {
      const db = new Database(join(policy.stateDir, "devspace.sqlite"), {
        readonly: true, fileMustExist: true,
      });
      let session: {
        root: string; source_root: string | null;
        mode: string; managed: string; status: string;
      } | undefined;
      try {
        session = db.prepare(
          "select root, source_root, mode, managed, status from workspace_sessions where id = ?",
        ).get(input.workspaceId) as typeof session;
      } finally { db.close(); }

      if (session?.status !== "active" || session.mode !== "worktree" ||
          session.managed !== "true" || canonical(session.root) !== root ||
          !session.source_root) {
        throw new Error("The workspace is not an active registered managed worktree.");
      }
      assertAllowedPath(canonical(session.source_root), roots);
      return root;
    } catch {
      throw new AccessDeniedError(
        "Workspace root is not an authorized, active Synrex-managed worktree.",
      );
    }
  }
}
