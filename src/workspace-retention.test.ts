import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { git } from "./git.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { pruneStaleWorkspaceMetadata } from "./workspace-retention.js";

test("workspace metadata retention removes stale checkout state, bindings, and review refs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "hello\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial commit"]);

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    storage: { stateDir, metadataRetentionDays: 30 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const session = store.createSession({ id: "ws_stale", root: project, mode: "checkout" });
  store.setConversationBinding({
    conversationScopeId: "old-chat",
    targetKey: "checkout:project",
    workspaceSessionId: session.id,
  });
  const reviews = createReviewCheckpointManager();
  assert.deepEqual(await reviews.initializeWorkspace({ workspaceId: session.id, root: project }), { available: true });
  store.close();

  const old = new Date("2025-01-01T00:00:00.000Z").toISOString();
  const database = openDatabase(stateDir);
  database.sqlite.prepare("update workspace_sessions set last_used_at = ? where id = ?").run(old, session.id);
  database.sqlite.prepare("update workspace_conversation_bindings set last_used_at = ? where workspace_session_id = ?").run(old, session.id);
  database.close();

  const cleanup = await pruneStaleWorkspaceMetadata(config, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(cleanup.isErr(), false);
  if (cleanup.isErr()) return;
  assert.deepEqual(cleanup.value, { sessions: 1, conversationBindings: 1, reviewRefWorkspaces: 1 });

  const verifyStore = new SqliteWorkspaceStore(stateDir);
  assert.equal(verifyStore.getSession(session.id), undefined);
  assert.equal(verifyStore.getConversationBinding("old-chat", "checkout:project"), undefined);
  verifyStore.close();
  await assert.rejects(() => git(project, ["rev-parse", "--verify", "refs/devspace/review/ws_stale/open"]));
});

test("metadata retention does not delete active managed worktree sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-retention-worktree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    storage: { stateDir, metadataRetentionDays: 30 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const session = store.createSession({ id: "ws_live_worktree", root: project, mode: "worktree", managed: true });
  store.close();
  const database = openDatabase(stateDir);
  database.sqlite.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2025-01-01T00:00:00.000Z", session.id);
  database.close();

  const cleanup = await pruneStaleWorkspaceMetadata(config, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(cleanup.isErr(), false);
  const verifyStore = new SqliteWorkspaceStore(stateDir);
  assert.ok(verifyStore.getSession(session.id));
  verifyStore.close();
});

test("metadata retention keeps a stale checkout session when a conversation binding is still fresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-retention-fresh-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    storage: { stateDir, metadataRetentionDays: 30 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const session = store.createSession({ id: "ws_fresh_binding", root: project, mode: "checkout" });
  store.setConversationBinding({
    conversationScopeId: "active-chat",
    targetKey: "checkout:project",
    workspaceSessionId: session.id,
  });
  store.close();
  const database = openDatabase(stateDir);
  database.sqlite.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2025-01-01T00:00:00.000Z", session.id);
  database.sqlite.prepare("update workspace_conversation_bindings set last_used_at = ? where workspace_session_id = ?")
    .run("2026-09-20T00:00:00.000Z", session.id);
  database.close();

  const cleanup = await pruneStaleWorkspaceMetadata(config, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(cleanup.isErr(), false);
  const verifyStore = new SqliteWorkspaceStore(stateDir);
  assert.ok(verifyStore.getSession(session.id));
  assert.ok(verifyStore.getConversationBinding("active-chat", "checkout:project"));
  verifyStore.close();
});

test("metadata retention removes review refs for already-pruned worktrees through sourceRoot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-retention-pruned-worktree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(source, ["init"]);
  await git(source, ["config", "user.email", "devspace@example.com"]);
  await git(source, ["config", "user.name", "DevSpace Test"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "Initial commit"]);
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    storage: { stateDir, metadataRetentionDays: 30 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const session = store.createSession({
    id: "ws_pruned_worktree",
    root: join(root, "missing-worktree"),
    sourceRoot: source,
    mode: "worktree",
    managed: true,
  });
  assert.equal(store.markSessionPruned(session.id).isErr(), false);
  store.close();
  const reviews = createReviewCheckpointManager();
  assert.deepEqual(await reviews.initializeWorkspace({ workspaceId: session.id, root: source }), { available: true });
  const database = openDatabase(stateDir);
  database.sqlite.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2025-01-01T00:00:00.000Z", session.id);
  database.close();

  const cleanup = await pruneStaleWorkspaceMetadata(config, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(cleanup.isErr(), false);
  await assert.rejects(() => git(source, ["rev-parse", "--verify", "refs/devspace/review/ws_pruned_worktree/open"]));
});
