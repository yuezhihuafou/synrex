import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import { authorizeAgentWorkspaceRoot } from "./managed-worktree-authorization.js";

test("subagents accept only an active, registered managed worktree under an approved source", () => {
  const temp = mkdtempSync(join(tmpdir(), "synrex-managed-agent-"));
  try {
    const source = join(temp, "source");
    const worktreeRoot = join(temp, "worktrees");
    const managed = join(worktreeRoot, "owned");
    const unregistered = join(worktreeRoot, "unregistered");
    const otherSource = join(temp, "other-source");
    const stateDir = join(temp, "state");
    for (const dir of [source, managed, unregistered, otherSource, stateDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const db = new Database(join(stateDir, "devspace.sqlite"));
    db.exec("create table workspace_sessions (id text primary key, root text, source_root text, mode text, managed text, status text)");
    const add = db.prepare("insert into workspace_sessions (id,root,source_root,mode,managed,status) values (?,?,?,?,?,?)");
    add.run("valid", managed, source, "worktree", "true", "active");
    add.run("pruned", managed, source, "worktree", "true", "pruned");
    add.run("not-managed", managed, source, "worktree", "false", "active");
    add.run("wrong-source", managed, otherSource, "worktree", "true", "active");
    db.close();

    const policy = { stateDir, worktreeRoot };
    const input = (workspaceId: string, workspaceRoot = managed) => ({
      workspaceId, workspaceRoot, allowedRoots: [source], managedWorktrees: policy,
    });
    assert.equal(authorizeAgentWorkspaceRoot(input("valid")), managed);
    assert.deepEqual(resolveCliWorkspaceContext([source], {
      DEVSPACE_WORKSPACE_ID: "valid", DEVSPACE_WORKSPACE_ROOT: managed,
    }, managed, policy), { workspaceId: "valid", workspaceRoot: managed });
    for (const rejected of ["unknown", "pruned", "not-managed", "wrong-source"]) {
      assert.throws(() => authorizeAgentWorkspaceRoot(input(rejected)), /not an authorized/);
    }
    assert.throws(() => authorizeAgentWorkspaceRoot(input("valid", unregistered)), /not an authorized/);
    assert.throws(() => authorizeAgentWorkspaceRoot(input("valid", otherSource)), /outside allowed roots/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
