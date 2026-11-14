#!/usr/bin/env node
/** Read-only Git history/worktree inventory for Synrex release integration. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function parseWorktrees(text) {
  return text.trim().split(/\n\n+/).filter(Boolean).map(block => {
    const fields = {};
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) fields[line.slice(0, space)] = line.slice(space + 1);
      else if (line) fields[line] = true;
    }
    return fields;
  }).filter(w => typeof w.worktree === "string");
}

export function auditHistory(repo = ".") {
  const path = resolve(repo);
  const canonical = git(path, "rev-parse", "--show-toplevel");
  const main = git(path, "rev-parse", "origin/main");
  const branches = git(path, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n").filter(Boolean).map(branch => {
      const [behind, ahead] = git(path, "rev-list", "--left-right", "--count", "origin/main..." + branch)
        .split(/\s+/).map(Number);
      const cherry = git(path, "cherry", "origin/main", branch).split("\n").filter(Boolean);
      const patchNew = cherry.filter(x => x.startsWith("+ ")).length;
      const patchEquivalent = cherry.filter(x => x.startsWith("- ")).length;
      return { branch, head: git(path, "rev-parse", branch), ahead, behind,
        patchNew, patchEquivalent,
        decision: patchNew ? "review_candidate"
          : ahead ? "patch_equivalent_to_main" : "ancestor_or_main" };
    });
  const worktrees = parseWorktrees(git(path, "worktree", "list", "--porcelain")).map(w => {
    const state = git(w.worktree, "status", "--porcelain=v1", "--untracked-files=normal")
      .split("\n").filter(Boolean);
    const tracked = state.filter(s => !s.startsWith("??")).length;
    const untracked = state.length - tracked;
    const [behind, ahead] = git(path, "rev-list", "--left-right", "--count",
      "origin/main..." + w.HEAD).split(/\s+/).map(Number);
    return { checkout: w.worktree, label: basename(w.worktree),
      branch: typeof w.branch === "string" ? w.branch.replace("refs/heads/", "") : null,
      head: w.HEAD, ahead, behind, tracked, untracked,
      assessment: tracked || untracked ? "preserve_dirty_wip"
        : ahead ? "review_detached_history" : "clean_historical_or_current" };
  });
  return {
    kind: "synrex_history_inventory_v1", scannedAt: new Date().toISOString(),
    canonical, baseRef: "origin/main", baseSha: main,
    branchCount: branches.length, worktreeCount: worktrees.length,
    dirtyWorktrees: worktrees.filter(w => w.tracked + w.untracked > 0).length,
    branches, worktrees,
    rule: "Observational only. Patch equivalence is not functional equivalence; dirty/untracked files are never discarded.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const repo = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".";
    const report = auditHistory(repo);
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("main " + report.baseSha + "\nlocal branches " + report.branchCount +
        ", worktrees " + report.worktreeCount + ", dirty " + report.dirtyWorktrees);
      for (const item of report.branches.filter(x => x.decision !== "ancestor_or_main")) {
        console.log(item.decision + ": " + item.branch + " +" + item.ahead +
          "/-" + item.behind + ", new patches=" + item.patchNew);
      }
      console.log("No files or Git references were modified.");
    }
  } catch (error) {
    console.error("HISTORY_AUDIT_UNAVAILABLE", error.message);
    process.exitCode = 1;
  }
}
