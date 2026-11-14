import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditHistory, parseWorktrees } from "./history-audit.mjs";

test("Git porcelain parser handles detached and normal branch worktrees", () => {
  const parsed = parseWorktrees("worktree /tmp/a\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/b\nHEAD def\ndetached\n");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].branch, "refs/heads/main");
  assert.equal(parsed[1].detached, true);
});

test("audit is read-only and identifies tracked WIP without changing Git", t => {
  const root = mkdtempSync(join(tmpdir(), "synrex-audit-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "a.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("branch", "feature");
  git("checkout", "-q", "feature");
  writeFileSync(join(repo, "feature.txt"), "unique code\n");
  git("add", "feature.txt");
  git("commit", "-qm", "unmerged feature");
  git("checkout", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "uncommitted\n");
  const status = git("status", "--porcelain");
  const report = auditHistory(repo);
  assert.equal(report.branchCount, 2);
  assert.equal(report.dirtyWorktrees, 1);
  assert.equal(report.baseSha, git("rev-parse", "HEAD"));
  assert.equal(git("status", "--porcelain"), status);
  assert.equal(report.branches.find(x => x.branch === "feature")?.decision, "review_candidate");
  assert.equal(report.branches.find(x => x.branch === "feature")?.patchNew, 1);
});
