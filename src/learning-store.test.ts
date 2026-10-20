import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { LearningStore } from "./learning-store.js";

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
    procedure: ["Run tests."],
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
