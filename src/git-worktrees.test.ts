import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Result, type Result as BetterResult } from "better-result";
import {
  cleanupManagedWorktrees,
  ManagedWorktreeError,
  managedWorktreeRecoveryRef,
  restoreManagedWorktree,
} from "./git-worktrees.js";
import {
  SqliteWorkspaceStore,
  WorkspaceStoreError,
  type WorkspaceRecoveryKind,
} from "./workspace-store.js";

const execFileAsync = promisify(execFile);

test("stale clean worktrees at their base are removed without recovery refs", async (t) => {
  const fixture = await worktreeFixture(t, "ws_clean");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0]?.recoverySha, undefined);
  assert.equal(await pathExists(fixture.worktreePath), false);
  assert.equal(fixture.store.getSession("ws_clean")?.status, "pruned");
  assert.equal(fixture.store.getSession("ws_clean")?.recoveryKind, undefined);
  await assert.rejects(() => git(
    fixture.sourceRoot,
    ["show-ref", "--verify", managedWorktreeRecoveryRef("ws_clean")],
  ));

  const session = fixture.store.getSession("ws_clean");
  assert.ok(session);
  unwrap(await restoreManagedWorktree({
    session,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
  }));
  assert.equal(await git(fixture.worktreePath, ["rev-parse", "HEAD"]), session.baseSha);
});

test("safe worktree cleanup has a read-only preview and removes only merged clean state", async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_preview");
  const base = await git(fixture.sourceRoot, ["rev-parse", "HEAD"]);
  await git(fixture.sourceRoot, ["update-ref", "refs/remotes/origin/main", base]);

  const options = {
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
    safeOnly: true,
  };
  const preview = unwrap(await cleanupManagedWorktrees({ ...options, dryRun: true }));
  assert.deepEqual(preview.wouldRemove, ["ws_safe_preview"]);
  assert.equal(preview.removed.length, 0);
  assert.equal(await pathExists(fixture.worktreePath), true);
  assert.equal(fixture.store.getSession("ws_safe_preview")?.status, "active");

  const actual = unwrap(await cleanupManagedWorktrees(options));
  assert.equal(actual.removed.length, 1);
  assert.equal(await pathExists(fixture.worktreePath), false);
});

test("safe pruning refuses changed files even though recoverable legacy prune could stash them", async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_dirty");
  const base = await git(fixture.sourceRoot, ["rev-parse", "HEAD"]);
  await git(fixture.sourceRoot, ["update-ref", "refs/remotes/origin/main", base]);
  await writeFile(join(fixture.worktreePath, "README.md"), "unsaved feature work\n");
  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store, worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root], staleBefore: futureCutoff(), safeOnly: true,
  }));
  assert.deepEqual(result.skipped, [{ workspaceId: "ws_safe_dirty", reason: "tracked_changes" }]);
  assert.equal(await pathExists(fixture.worktreePath), true);
  assert.equal(fixture.store.getSession("ws_safe_dirty")?.status, "active");
});

test("safe pruning refuses unique commits even when the worktree is clean", async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_unmerged");
  const base = await git(fixture.sourceRoot, ["rev-parse", "HEAD"]);
  await git(fixture.sourceRoot, ["update-ref", "refs/remotes/origin/main", base]);
  await writeFile(join(fixture.worktreePath, "feature.txt"), "not on main\n");
  await git(fixture.worktreePath, ["add", "feature.txt"]);
  await git(fixture.worktreePath, ["commit", "-m", "Unique user feature"]);
  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store, worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root], staleBefore: futureCutoff(), safeOnly: true,
  }));
  assert.deepEqual(result.skipped, [{ workspaceId: "ws_safe_unmerged", reason: "unmerged_commits" }]);
  assert.equal(await pathExists(join(fixture.worktreePath, "feature.txt")), true);
});

test("safe pruning does not erase unexpected ignored state", async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_ignored", { gitignore: ".devspace/\n" });
  const base = await git(fixture.sourceRoot, ["rev-parse", "HEAD"]);
  await git(fixture.sourceRoot, ["update-ref", "refs/remotes/origin/main", base]);
  await mkdir(join(fixture.worktreePath, ".devspace"));
  await writeFile(join(fixture.worktreePath, ".devspace", "session.json"), "{}\n");
  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store, worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root], staleBefore: futureCutoff(), safeOnly: true,
  }));
  assert.deepEqual(result.skipped, [{ workspaceId: "ws_safe_ignored", reason: "ignored_state" }]);
  assert.equal(await pathExists(join(fixture.worktreePath, ".devspace", "session.json")), true);
});

test("safe pruning preserves a worktree while an independent process uses its cwd", {
  skip: platform() !== "linux",
}, async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_busy");
  const base = await git(fixture.sourceRoot, ["rev-parse", "HEAD"]);
  await git(fixture.sourceRoot, ["update-ref", "refs/remotes/origin/main", base]);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: fixture.worktreePath, stdio: "ignore",
  });
  await once(child, "spawn");
  try {
    const result = unwrap(await cleanupManagedWorktrees({
      store: fixture.store, worktreeRoot: fixture.worktreeRoot,
      allowedRoots: [fixture.root], staleBefore: futureCutoff(), safeOnly: true,
    }));
    assert.deepEqual(result.skipped, [{ workspaceId: "ws_safe_busy", reason: "active_process" }]);
    assert.equal(await pathExists(fixture.worktreePath), true);
  } finally {
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  }
});

test("safe dry-run does not delete stale sessions whose worktree directory is already missing", async (t) => {
  const fixture = await worktreeFixture(t, "ws_safe_missing");
  await git(fixture.sourceRoot, ["worktree", "remove", fixture.worktreePath]);
  const preview = unwrap(await cleanupManagedWorktrees({
    store: fixture.store, worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root], staleBefore: futureCutoff(), dryRun: true,
  }));
  assert.deepEqual(preview.missing, []);
  assert.deepEqual(preview.skipped, [{ workspaceId: "ws_safe_missing", reason: "missing_path" }]);
  assert.ok(fixture.store.getSession("ws_safe_missing"), "Dry-run must not mutate the session database");
});

test("detached commits remain reachable through a recovery ref", async (t) => {
  const fixture = await worktreeFixture(t, "ws_committed");
  await writeFile(join(fixture.worktreePath, "committed.txt"), "kept\n");
  await git(fixture.worktreePath, ["add", "committed.txt"]);
  await git(fixture.worktreePath, ["commit", "-m", "Worktree change"]);
  const head = await git(fixture.worktreePath, ["rev-parse", "HEAD"]);

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.removed[0]?.recoverySha, head);
  assert.equal(fixture.store.getSession("ws_committed")?.status, "pruned");
  assert.equal(fixture.store.getSession("ws_committed")?.recoveryKind, "head");
  assert.equal(
    await git(fixture.sourceRoot, ["show", `${managedWorktreeRecoveryRef("ws_committed")}:committed.txt`]),
    "kept",
  );

  const session = fixture.store.getSession("ws_committed");
  assert.ok(session);
  unwrap(await restoreManagedWorktree({
    session,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
  }));
  assert.equal(await git(fixture.worktreePath, ["show", "HEAD:committed.txt"]), "kept");
});

test("tracked worktree changes are snapshotted before cleanup", async (t) => {
  const fixture = await worktreeFixture(t, "ws_dirty");
  await writeFile(join(fixture.worktreePath, "README.md"), "changed in worktree\n");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.removed.length, 1);
  assert.equal(await pathExists(fixture.worktreePath), false);
  assert.equal(fixture.store.getSession("ws_dirty")?.status, "pruned");
  assert.equal(fixture.store.getSession("ws_dirty")?.recoveryKind, "stash");
  assert.equal(
    await git(fixture.sourceRoot, ["show", `${managedWorktreeRecoveryRef("ws_dirty")}:README.md`]),
    "changed in worktree",
  );

  const session = fixture.store.getSession("ws_dirty");
  assert.ok(session);
  unwrap(await restoreManagedWorktree({
    session,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
  }));
  assert.equal(await git(fixture.worktreePath, ["status", "--short"]), "M README.md");
});

test("non-ignored untracked files keep a stale worktree alive", async (t) => {
  const fixture = await worktreeFixture(t, "ws_untracked");
  await writeFile(join(fixture.worktreePath, "new-file.ts"), "important work\n");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.deepEqual(result.skipped, [{ workspaceId: "ws_untracked", reason: "untracked_files" }]);
  assert.equal(await pathExists(fixture.worktreePath), true);
  assert.ok(fixture.store.getSession("ws_untracked"));
});

test("ignored worktree files are discarded during cleanup", async (t) => {
  const fixture = await worktreeFixture(t, "ws_ignored", { gitignore: "cache/\n" });
  await mkdir(join(fixture.worktreePath, "cache"));
  await writeFile(join(fixture.worktreePath, "cache", "artifact.bin"), "reproducible\n");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.removed.length, 1);
  assert.equal(await pathExists(fixture.worktreePath), false);
});

test("missing worktree directories only clear stale persisted sessions", async (t) => {
  const fixture = await worktreeFixture(t, "ws_missing");
  await git(fixture.sourceRoot, ["worktree", "remove", fixture.worktreePath]);

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.deepEqual(result.missing, ["ws_missing"]);
  assert.equal(fixture.store.getSession("ws_missing"), undefined);
});

test("one broken stale session does not block cleanup of another", async (t) => {
  const fixture = await worktreeFixture(t, "ws_good");
  const brokenPath = join(fixture.worktreeRoot, "broken");
  await mkdir(brokenPath);
  fixture.store.createSession({
    id: "ws_broken",
    root: brokenPath,
    mode: "worktree",
    managed: true,
  });

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.removed.some((entry) => entry.workspaceId === "ws_good"), true);
  assert.equal(result.failed.some((entry) => entry.workspaceId === "ws_broken"), true);
  assert.equal(ManagedWorktreeError.is(result.failed[0]?.error), true);
  assert.ok(fixture.store.getSession("ws_broken"));
});

test("prune persistence failure restores the removed worktree", async (t) => {
  class FailPruneStore extends SqliteWorkspaceStore {
    override markSessionPruned(
      id: string,
      _recoveryKind?: WorkspaceRecoveryKind,
    ): BetterResult<void, WorkspaceStoreError> {
      return Result.err(new WorkspaceStoreError(
        "mark_session_pruned",
        new Error("injected persistence failure"),
        id,
      ));
    }
  }

  const fixture = await worktreeFixture(t, "ws_store_failure", {
    createStore: (stateDir) => new FailPruneStore(stateDir),
  });
  await writeFile(join(fixture.worktreePath, "README.md"), "recover me\n");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.failed.length, 1);
  assert.equal(WorkspaceStoreError.is(result.failed[0]?.error), true);
  assert.equal(await pathExists(fixture.worktreePath), true);
  assert.equal(await git(fixture.worktreePath, ["status", "--short"]), "M README.md");
  assert.equal(fixture.store.getSession("ws_store_failure")?.status, "active");
});

test("failed prune compensation leaves the session pruned for later recovery", async (t) => {
  class FailOnceAndBreakRecoveryStore extends SqliteWorkspaceStore {
    sourceRoot?: string;
    private failNextPrune = true;

    override markSessionPruned(
      id: string,
      recoveryKind?: WorkspaceRecoveryKind,
    ): BetterResult<void, WorkspaceStoreError> {
      if (this.failNextPrune) {
        this.failNextPrune = false;
        assert.ok(this.sourceRoot);
        execFileSync("git", ["update-ref", "-d", managedWorktreeRecoveryRef(id)], {
          cwd: this.sourceRoot,
        });
        return Result.err(new WorkspaceStoreError(
          "mark_session_pruned",
          new Error("injected persistence failure"),
          id,
        ));
      }
      return super.markSessionPruned(id, recoveryKind);
    }
  }

  let store!: FailOnceAndBreakRecoveryStore;
  const fixture = await worktreeFixture(t, "ws_failed_compensation", {
    createStore: (stateDir) => {
      store = new FailOnceAndBreakRecoveryStore(stateDir);
      return store;
    },
  });
  store.sourceRoot = fixture.sourceRoot;
  await writeFile(join(fixture.worktreePath, "README.md"), "recover later\n");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.failed.length, 1);
  assert.equal(ManagedWorktreeError.is(result.failed[0]?.error), true);
  assert.equal(await pathExists(fixture.worktreePath), false);
  assert.equal(fixture.store.getSession("ws_failed_compensation")?.status, "pruned");
  assert.equal(fixture.store.getSession("ws_failed_compensation")?.recoveryKind, "stash");
});

test("cleanup rejects a managed worktree path replaced by a symlink", { skip: platform() === "win32" }, async (t) => {
  const fixture = await worktreeFixture(t, "ws_symlink");
  const victimRoot = join(fixture.root, "victim");
  await mkdir(victimRoot);
  await writeFile(join(victimRoot, "KEEP.txt"), "keep\n");
  await git(victimRoot, ["init"]);
  await git(victimRoot, ["config", "user.email", "devspace@example.com"]);
  await git(victimRoot, ["config", "user.name", "DevSpace Test"]);
  await git(victimRoot, ["add", "."]);
  await git(victimRoot, ["commit", "-m", "Victim commit"]);

  await rm(fixture.worktreePath, { recursive: true, force: true });
  await symlink(victimRoot, fixture.worktreePath, "dir");

  const result = unwrap(await cleanupManagedWorktrees({
    store: fixture.store,
    worktreeRoot: fixture.worktreeRoot,
    allowedRoots: [fixture.root],
    staleBefore: futureCutoff(),
  }));

  assert.equal(result.failed.some((entry) => entry.workspaceId === "ws_symlink"), true);
  assert.equal(await pathExists(join(victimRoot, "KEEP.txt")), true);
  assert.equal(fixture.store.getSession("ws_symlink")?.status, "active");
});

interface WorktreeFixture {
  root: string;
  sourceRoot: string;
  worktreeRoot: string;
  worktreePath: string;
  store: SqliteWorkspaceStore;
}

async function worktreeFixture(
  t: TestContext,
  workspaceId: string,
  options: {
    gitignore?: string;
    createStore?: (stateDir: string) => SqliteWorkspaceStore;
  } = {},
): Promise<WorktreeFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-worktree-cleanup-test-"));
  const sourceRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, workspaceId);
  const stateDir = join(root, "state");
  await mkdir(sourceRoot);
  await mkdir(worktreeRoot);
  await writeFile(join(sourceRoot, "README.md"), "initial\n");
  if (options.gitignore) await writeFile(join(sourceRoot, ".gitignore"), options.gitignore);
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["config", "user.email", "devspace@example.com"]);
  await git(sourceRoot, ["config", "user.name", "DevSpace Test"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "Initial commit"]);
  await git(sourceRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

  const store = options.createStore?.(stateDir) ?? new SqliteWorkspaceStore(stateDir);
  store.createSession({
    id: workspaceId,
    root: worktreePath,
    mode: "worktree",
    sourceRoot,
    baseRef: "HEAD",
    baseSha: await git(sourceRoot, ["rev-parse", "HEAD"]),
    managed: true,
  });

  t.after(async () => {
    store.close();
    await git(sourceRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  return { root, sourceRoot, worktreeRoot, worktreePath, store };
}

function futureCutoff(): Date {
  return new Date(Date.now() + 60_000);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
