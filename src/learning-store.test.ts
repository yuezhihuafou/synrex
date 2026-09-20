import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
