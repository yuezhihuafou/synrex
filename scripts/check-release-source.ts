/** Read-only preflight for a reproducible source-backed release candidate. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFingerprint } from "../src/multinode/local-node.js";
import { evaluateReleaseSource, type ReleaseSourceEvidence } from "../src/release-source-check.js";

const root = resolve(import.meta.dirname, "..");
const reportOnly = process.argv.includes("--report");
const git = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
};
const head = git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
let buildInfo: Record<string, unknown> = {};
try {
  buildInfo = JSON.parse(readFileSync(resolve(root, "dist/build-info.json"), "utf8")) as Record<string, unknown>;
} catch { /* Explicitly rejected as absent build evidence. */ }
const assets = ["dist/cli.js", "dist/server.js", "dist/ui/.vite/manifest.json",
  "package.json", "skills/subagents/SKILL.md"];
const evidence: ReleaseSourceEvidence = {
  head,
  sourceDirty: status === null ? null : status.length > 0,
  buildRevision: typeof buildInfo.revision === "string" ? buildInfo.revision : null,
  buildDirty: typeof buildInfo.dirty === "boolean" ? buildInfo.dirty : null,
  currentFingerprint: sourceFingerprint(root),
  buildFingerprint: typeof buildInfo.sourceFingerprint === "string" ? buildInfo.sourceFingerprint : null,
  requiredAssetsPresent: assets.every((file) => existsSync(resolve(root, file))),
};
const failures = evaluateReleaseSource(evidence);
const result = {
  ready: failures.length === 0,
  revision: head,
  recordedBuildRevision: evidence.buildRevision,
  sourceFingerprint: evidence.currentFingerprint,
  dirty: evidence.sourceDirty,
  issues: failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length && !reportOnly) process.exitCode = 1;
