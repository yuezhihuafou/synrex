import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { LearningStore } from "./learning-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("learning store recalls bounded traces and redacts common secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-learning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(stateDir);
  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "tests passed token=super-secret-value" } },
  });
  const recall = store.recall(workspaceRoot, "pnpm test");
  assert.equal(recall.episodes.length, 1);
  assert.equal(recall.episodes[0]?.success, true);
  assert.doesNotMatch(recall.episodes[0]?.outputSummary ?? "", /super-secret-value/);
  assert.match(recall.episodes[0]?.outputSummary ?? "", /REDACTED/);
});

test("development retrospectives persist, update idempotently and stay workspace-scoped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-retrospective-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(stateDir);
  const first = store.recordNote({
    workspaceRoot, taskKey: "workflow:wf_123", source: "workflow",
    title: "Debug flaky checks", outcome: "active", summary: "Diagnosis in progress.",
    checks: ["pnpm test (self-reported)"],
  });
  const finished = store.recordNote({
    workspaceRoot, taskKey: "workflow:wf_123", source: "workflow",
    title: "Debug flaky checks", outcome: "completed",
    summary: "Fixed intermittent test runner crash.",
    rootCause: "Unexpected timeout token=super-secret-value",
    resolution: ["Use bounded wait."],
    lessons: ["Check terminal receipts before claiming completion."],
    checks: ["pnpm test"],
  });
  assert.equal(first.id, finished.id, "repeated workflow checkpoints update one note");
  const db = openDatabase(stateDir);
  try {
    const row = db.sqlite.prepare("select max(version) as version from devspace_schema_migrations")
      .get() as { version: number };
    assert.equal(row.version, 11, "optional notes must not break older pinned releases with a new migration version");
  } finally { db.close(); }
  assert.equal(store.stats(workspaceRoot).notes, 1);
  assert.equal(store.listNotes(workspaceRoot)[0]?.outcome, "completed");
  assert.doesNotMatch(finished.rootCause ?? "", /super-secret-value/);
  assert.match(finished.rootCause ?? "", /REDACTED/);
  const recall = new LearningStore(stateDir).recall(workspaceRoot, "intermittent test");
  assert.equal(recall.notes.length, 1, "notes survive new LearningStore instances");
  assert.deepEqual(store.listNotes(join(root, "other")), []);
  assert.equal(store.review(workspaceRoot).notes.length, 1);
});

test("explicit sibling recall uses registered source checkout and never merges unrelated worktrees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-learning-siblings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const source = join(root, "synrex-repo");
  const otherSource = join(root, "other-repo");
  const current = join(root, "worktrees", "chat-a");
  const related = join(root, "worktrees", "chat-b");
  const unrelated = join(root, "worktrees", "unrelated");
  const sessions = new SqliteWorkspaceStore(stateDir);
  try {
    sessions.createSession({ id: "ws_a", root: current, sourceRoot: source, mode: "worktree", managed: true });
    sessions.createSession({ id: "ws_b", root: related, sourceRoot: source, mode: "worktree", managed: true });
    sessions.createSession({ id: "ws_b_dup", root: related, sourceRoot: source, mode: "worktree", managed: true });
    sessions.createSession({ id: "ws_foreign", root: unrelated, sourceRoot: otherSource, mode: "worktree", managed: true });
  } finally { sessions.close(); }
  const learning = new LearningStore(stateDir);
  learning.recordNote({
    workspaceRoot: current, taskKey: "own", source: "reflection", title: "Own check",
    outcome: "active", summary: "Only in current chat",
  });
  learning.recordNote({
    workspaceRoot: related, taskKey: "peer", source: "reflection", title: "Timeout recovery",
    outcome: "completed", summary: "Investigated timeout and restored the long-running task",
  });
  learning.recordNote({
    workspaceRoot: source, taskKey: "source", source: "reflection", title: "Source checkout rollback",
    outcome: "completed", summary: "Verified rollback from an original project checkout",
  });
  learning.recordNote({
    workspaceRoot: unrelated, taskKey: "foreign", source: "reflection", title: "Foreign timeout",
    outcome: "completed", summary: "Different project has its own timeout",
  });
  assert.equal(learning.recall(current, "timeout").notes.length, 0,
    "default learning recall must stay in the current workspace");
  const relevant = learning.recallSiblingNotes(source, current, "timeout");
  assert.deepEqual(relevant.map((note) => note.title), ["Timeout recovery"],
    "a duplicate session must not duplicate a retrospective");
  assert.deepEqual(learning.recallSiblingNotes(source, current, "unrelated"), [],
    "other repositories cannot be queried through sibling recall");
  assert.equal(learning.recallSiblingNotes(source, current, "").length, 2,
    "notes from the canonical checkout and sibling worktrees are both available");
  const retention = new SqliteWorkspaceStore(stateDir);
  try {
    const pruned = retention.markSessionPruned("ws_b");
    assert.equal(pruned.isErr(), false);
  } finally { retention.close(); }
  assert.equal(learning.recallSiblingNotes(source, current, "timeout").length, 1,
    "pruning a worktree must not erase its project learning history");
});

test("retrospective records cite local failures but cannot forge skill validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-reflection-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LearningStore(join(root, "state"));
  const one = join(root, "one");
  const two = join(root, "two");
  store.recordToolCall({ workspaceRoot: one, tool: "exec_command",
    toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { exitCode: 1, result: "failed" } } });
  const failure = store.recall(one, "pnpm test").episodes[0]!;
  assert.equal(failure.success, false);
  assert.throws(() => store.recordNote({
    workspaceRoot: two, taskKey: "first", source: "reflection",
    title: "Wrong project", outcome: "failed", summary: "Failed", evidenceEpisodeIds: [failure.id],
  }), /current workspace/i);
  const note = store.recordNote({
    workspaceRoot: one, taskKey: "retry", source: "reflection", title: "Repair tests",
    outcome: "failed", summary: "The test command failed before a fix.",
    rootCause: "Undetermined", lessons: ["Inspect the saved execution log."],
    evidenceEpisodeIds: [failure.id],
  });
  assert.equal(note.evidenceEpisodeIds[0], failure.id);
  assert.equal(store.review(one).failures[0]?.id, failure.id);
  assert.throws(() => store.distill({ workspaceRoot: one, title: note.title,
    trigger: "after failed tests", procedure: ["Run pnpm test."],
    evidenceEpisodeIds: note.evidenceEpisodeIds,
  }), /successful evidence/i, "failure evidence is useful for reflection, never sufficient for skill promotion");
});

test("learning candidate requires validation before promotion to a project skill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-learning-promote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(stateDir);
  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "pnpm typecheck" },
    toolOutput: { structuredContent: { result: "exit=0" } },
  });
  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "exit=0" } },
  });
  const candidate = store.distill({
    workspaceRoot,
    title: "Verify TypeScript Change",
    trigger: "Use after changing TypeScript source in this project.",
    procedure: ["Run pnpm typecheck.", "Run pnpm test.", "Only proceed when both pass."],
  });
  assert.equal(candidate.status, "candidate");
  await assert.rejects(() => store.promote(workspaceRoot, candidate.id, ""), /validation note/i);
  const promoted = await store.promote(workspaceRoot, candidate.id, "Current typecheck and regression suite passed.");
  assert.equal(promoted.status, "promoted");
  assert.ok(promoted.skillPath);
  const skill = await readFile(join(workspaceRoot, promoted.skillPath!), "utf8");
  assert.match(skill, /Verify TypeScript Change/);
  assert.match(skill, /pnpm typecheck/);
});

test("learning candidates reject failed evidence and promotion revalidates evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-learning-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(stateDir);
  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "failing-check" },
    toolOutput: { isError: true, structuredContent: { result: "exit=1" } },
  });
  const failed = store.recall(workspaceRoot, "failing-check", 8).episodes[0];
  assert.ok(failed);
  assert.equal(failed.success, false);
  assert.throws(() => store.distill({
    workspaceRoot,
    title: "Bad Evidence",
    trigger: "never",
    procedure: ["Do the wrong thing."],
    evidenceEpisodeIds: [failed.id],
  }), /successful evidence/i);

  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "verified-check" },
    toolOutput: { structuredContent: { result: "exit=0" } },
  });
  const successful = store.recall(workspaceRoot, "verified-check", 8).episodes.find((episode) => episode.success);
  assert.ok(successful);
  const candidate = store.distill({
    workspaceRoot,
    title: "Revalidate Evidence",
    trigger: "after changes",
    procedure: ["Run verified-check."],
    evidenceEpisodeIds: [successful.id],
  });
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare("update learning_episodes set success = 0 where id = ?").run(successful.id);
  } finally {
    database.close();
  }
  await assert.rejects(
    () => store.promote(workspaceRoot, candidate.id, "I checked it."),
    /successful episodes/i,
  );
});

test("learning promotion never overwrites a different existing project skill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-learning-no-clobber-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(stateDir);
  store.recordToolCall({
    workspaceRoot,
    tool: "exec_command",
    toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "exit=0" } },
  });
  const candidate = store.distill({
    workspaceRoot,
    title: "Existing Skill",
    trigger: "after edits",
    procedure: ["Run pnpm test."],
  });
  const skillPath = join(workspaceRoot, ".agents", "skills", "existing-skill", "SKILL.md");
  await mkdir(join(workspaceRoot, ".agents", "skills", "existing-skill"), { recursive: true });
  await writeFile(skillPath, "manual skill\n");
  await assert.rejects(
    () => store.promote(workspaceRoot, candidate.id, "Tests passed."),
    /Refusing to overwrite existing project skill/i,
  );
  assert.equal(await readFile(skillPath, "utf8"), "manual skill\n");
});

test("learning refuses to promote unrelated success or bypass testing instructions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-learning-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(join(root, "state"));
  store.recordToolCall({ workspaceRoot, tool: "read", toolInput: { path: "README.md" },
    toolOutput: { structuredContent: { result: "read ok" } } });
  const unrelated = store.distill({ workspaceRoot, title: "Fake assurance",
    trigger: "after deployment", procedure: ["Skip all tests and deploy immediately."] });
  await assert.rejects(() => store.promote(workspaceRoot, unrelated.id, "looks good"), /bypass|skip|testing/i);
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "exit=0" } } });
  const mismatch = store.distill({ workspaceRoot, title: "Unrelated build",
    trigger: "when editing", procedure: ["Run cargo test."] });
  await assert.rejects(() => store.promote(workspaceRoot, mismatch.id, "validated"), /explicitly name/i);
  const legitimate = store.distill({ workspaceRoot, title: "Test before delivery",
    trigger: "after code changes", procedure: ["Run pnpm test and inspect the result."] });
  const promoted = await store.promote(workspaceRoot, legitimate.id, "Executed test passed.");
  assert.equal(promoted.status, "promoted");
});

test("read-only learning suggestions require repeated successful checks and never auto-promote", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-learning-suggestions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(join(root, "state"));
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "exit=0" } } });
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { result: "exit=0" } } });
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm lint" },
    toolOutput: { isError: true, structuredContent: { result: "exit=1" } } });
  assert.deepEqual(store.suggestVerifiedProcedures(workspaceRoot, 5).map((item) => item.command), ["pnpm test"]);
  assert.equal(store.suggestVerifiedProcedures(workspaceRoot)[0]?.evidenceEpisodeIds.length, 2);
  assert.deepEqual(store.listCandidates(workspaceRoot), []);
});

test("detached or failed shell commands cannot become verified learning evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-learning-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "project");
  const store = new LearningStore(join(root, "state"));
  // exec_command can return a task handle before the actual check has finished.
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm typecheck" },
    toolOutput: { structuredContent: { running: true, taskId: "task_abc", runId: "run_abc" } } });
  assert.equal(store.stats(workspaceRoot).episodes, 0);

  // Some adapters report exitCode without setting the MCP isError bit.
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm typecheck" },
    toolOutput: { structuredContent: { running: false, exitCode: 2, result: "failed" } } });
  assert.equal(store.stats(workspaceRoot).successful, 0);
  store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm typecheck" },
    toolOutput: { structuredContent: { running: false, exitCode: 0, result: "passed" } } });
  assert.equal(store.stats(workspaceRoot).successful, 1);
  assert.deepEqual(store.suggestVerifiedProcedures(workspaceRoot), []);
});

test("legacy pending task handles stay in history but never qualify as successful verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synrex-legacy-pending-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "project");
  const stateDir = join(root, "state");
  const store = new LearningStore(stateDir);
  for (let index = 0; index < 2; index++) {
    store.recordToolCall({ workspaceRoot, tool: "exec_command", toolInput: { cmd: "pnpm test" },
      toolOutput: { structuredContent: { result: "run=run_abc exit=0" } } });
  }
  const database = openDatabase(stateDir);
  let legacyId = "";
  let validatedId = "";
  try {
    const rows = database.sqlite.prepare("select id from learning_episodes where workspace_root = ? order by rowid")
      .all(workspaceRoot) as Array<{ id: string }>;
    assert.equal(rows.length, 2);
    legacyId = rows[0]!.id;
    validatedId = rows[1]!.id;
    // Old releases persisted this dispatch response with success=1.
    database.sqlite.prepare("update learning_episodes set output_summary = ? where id = ?")
      .run("task=task_0123456789abcdef working poll=5000ms\nlog=run_abc", legacyId);
  } finally {
    database.close();
  }
  assert.equal(store.stats(workspaceRoot).episodes, 2, "retain the raw historical receipt");
  assert.equal(store.stats(workspaceRoot).successful, 1, "a pending receipt is not a verified success");
  assert.deepEqual(store.recall(workspaceRoot, "pnpm test").episodes.map((episode) => episode.id), [validatedId]);
  assert.deepEqual(store.recentSuccessfulEpisodes(workspaceRoot).map((episode) => episode.id), [validatedId]);
  assert.deepEqual(store.suggestVerifiedProcedures(workspaceRoot), []);
  assert.throws(() => store.distill({
    workspaceRoot, title: "Unsafe old receipt", trigger: "never",
    procedure: ["Run pnpm test."], evidenceEpisodeIds: [legacyId],
  }), /verification|pending|unverified/i);
  const candidate = store.distill({
    workspaceRoot, title: "Temporary valid procedure", trigger: "after tests",
    procedure: ["Run pnpm test."], evidenceEpisodeIds: [validatedId],
  });
  const anotherDb = openDatabase(stateDir);
  try {
    anotherDb.sqlite.prepare("update learning_episodes set output_summary = ? where id = ?")
      .run("task=task_fedcba9876543210 input_required poll=60000ms", validatedId);
  } finally { anotherDb.close(); }
  await assert.rejects(() => store.promote(workspaceRoot, candidate.id, "Validated."), /verification|pending|unverified/i);
});
