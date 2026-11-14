import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ServerConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { classifyWorkspaceLifecycle, listWorktreeLifecycle, pruneCompletedWorktrees } from "./workspace-lifecycle.js";
import { withWorkspaceLifecycleLock } from "./workspace-lifecycle-lock.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("lifecycle GC protects unknown/unfinished work, leases, dirty files; safely reclaims completed clean trees", async t => {
  const root = mkdtempSync(join(tmpdir(), "synrex-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project"), worktreeRoot = join(root, "trees");
  const tree = join(worktreeRoot, "lifecycle"), stateDir = join(root, "state");
  mkdirSync(project); mkdirSync(worktreeRoot);
  git(project, "init", "-q");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "user.name", "Test");
  writeFileSync(join(project, "file.txt"), "baseline\n");
  git(project, "add", "file.txt");git(project, "commit", "-qm", "base");
  const baseSha = git(project, "rev-parse", "HEAD");
  git(project, "update-ref", "refs/remotes/origin/main", baseSha);
  git(project, "worktree", "add", "--detach", tree, "HEAD");
  const id = "ws_lifecycle_fixture";
  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({ id, root: tree, mode: "worktree", managed: true,
    sourceRoot: project, baseRef: "HEAD", baseSha });
  store.close();
  const db = new Database(databasePath(stateDir));
  db.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run(new Date(Date.now() - 5 * 86_400_000).toISOString(), id);
  db.close();
  const config = { stateDir, worktreeRoot, allowedRoots: [root] } as ServerConfig;
  const preview = async () => {
    const r = await pruneCompletedWorktrees(config, new Date(), true);
    assert.ok(r.isOk(), r.isErr() ? r.error.message : "");
    return r.value;
  };
  assert.equal(listWorktreeLifecycle(stateDir)[0]?.reason, "unknown_workflow_owner");
  assert.deepEqual((await preview()).wouldRemove, []);

  const workflows = new CodingWorkflowStore(stateDir);
  const workflow = workflows.create(tree, {
    title: "safe lifecycle", goal: "finish test", acceptanceCriteria: ["verified"],
    constraints: [], workspaceId: id,
  });
  assert.equal(listWorktreeLifecycle(stateDir)[0]?.reason, "unfinished_workflow");
  assert.deepEqual((await preview()).wouldRemove, []);
  const finished = workflows.checkpoint(tree, {
    workflowId: workflow.workflowId, expectedRevision: 0, status: "completed",
    checkpoint: { summary: "test verified", phase: "finished", completedSteps: ["done"],
      nextSteps: [], blockers: [], taskIds: [], checks: ["test fixture verification"] },
  });
  assert.equal(finished.status, "completed");
  const lease = workflows.lease(id);
  assert.equal(listWorktreeLifecycle(stateDir)[0]?.reason, "active_lease");
  assert.deepEqual((await preview()).wouldRemove, []);
  // Two GC attempts racing an active lease must leave the tree accessible.
  const races = await Promise.all([pruneCompletedWorktrees(config), pruneCompletedWorktrees(config)]);
  assert.ok(races.every(result => result.isOk() && result.value.removed.length === 0));
  assert.equal(existsSync(tree), true);
  // An in-flight lifecycle transaction serializes a competing GC request.
  let notifyLocked!: () => void;
  const locked = new Promise<void>(resolve => { notifyLocked = resolve; });
  const hold = withWorkspaceLifecycleLock(stateDir, async () => {
    notifyLocked();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  await locked;
  const competing = pruneCompletedWorktrees(config);
  await hold;
  const gated = await competing;
  assert.ok(gated.isOk() && gated.value.removed.length === 0);
  assert.equal(existsSync(tree), true);
  assert.equal(workflows.lease(id, lease.leaseId).leaseId, lease.leaseId);
  assert.equal(workflows.releaseLease(id, lease.leaseId), true);
  assert.deepEqual((await preview()).wouldRemove, [id]);

  writeFileSync(join(tree, "file.txt"), "unsaved\n");
  const dirty = await preview();
  assert.deepEqual(dirty.wouldRemove, []);
  assert.deepEqual(dirty.skipped, [{ workspaceId: id, reason: "tracked_changes" }]);
  git(tree, "checkout", "--", "file.txt");
  workflows.close();
  const removed = await pruneCompletedWorktrees(config, new Date(), false);
  assert.ok(removed.isOk(), removed.isErr() ? removed.error.message : "");
  assert.deepEqual(removed.value.removed.map(r => r.workspaceId), [id]);
  assert.equal(existsSync(tree), false);
  assert.equal(listWorktreeLifecycle(stateDir)[0]?.status, "archived");
});

test("lifecycle classifier does not confuse idle tasks or unknown owners with safe deletion", () => {
  const session = { id: "ws_test_abc", root: "/tmp/none", source_root: null, status: "active",
    last_used_at: new Date(Date.now() - 8 * 86_400_000).toISOString() };
  assert.equal(classifyWorkspaceLifecycle({ session, workflowStatuses: [], activeLeases: 0 }).status, "protected");
  assert.equal(classifyWorkspaceLifecycle({ session, workflowStatuses: ["blocked"], activeLeases: 0 }).status, "active");
  assert.equal(classifyWorkspaceLifecycle({ session, workflowStatuses: ["completed"], activeLeases: 1 }).status, "active");
  assert.equal(classifyWorkspaceLifecycle({ session, workflowStatuses: ["completed"], activeLeases: 0 }).status, "reclaimable");
});
