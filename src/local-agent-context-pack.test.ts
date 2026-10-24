import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { LocalAgentContextPacks } from "./local-agent-context-pack.js";
import type { ProjectMemoryPort } from "./project-memory-port.js";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("context packs are bounded, content addressed, scoped and incrementally cached", async () => {
  const temp = mkdtempSync(join(tmpdir(), "synrex-context-pack-test-"));
  const repo = join(temp, "repo");
  const state = join(temp, "state");
  mkdirSync(repo);
  try {
    git(repo, "init", "-q");
    mkdirSync(join(repo, "src"));
    const source = join(repo, "src", "recovery.ts");
    writeFileSync(source, [
      "export function recoverSession() {",
      "  return 'old';",
      "}",
      "export interface SessionState {",
      "  revision: number;",
      "}",
    ].join("\n"));
    writeFileSync(join(repo, "src", "duplicate.ts"), [
      "export function recoverSession() {",
      "  return 'old';",
      "}",
      "export interface SessionState {",
      "  revision: number;",
      "}",
    ].join("\n"));
    writeFileSync(join(repo, ".env"), "SECRET_SHOULD_NOT_BE_IN_CONTEXT=private");
    writeFileSync(join(temp, "outside.ts"), "export const secret = 'outside';");
    symlinkSync(join(temp, "outside.ts"), join(repo, "src", "escape.ts"));
    git(repo, "add", ".");
    git(repo, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture");

    const workflows = new CodingWorkflowStore(state);
    const created = workflows.create(repo, {
      title: "Recovery", goal: "Repair session recovery",
      constraints: ["Preserve existing interfaces"],
      acceptanceCriteria: ["Recovery test passes"],
    });
    workflows.checkpoint(repo, {
      workflowId: created.workflowId, expectedRevision: 0, status: "blocked",
      checkpoint: {
        phase: "debug", summary: "An earlier attempt timed out",
        completedSteps: ["Located parser"], nextSteps: ["Repair recovery.ts"],
        blockers: ["Timeout"], checks: ["unverified"], taskIds: [],
      },
    });
    workflows.close();

    let recalls = 0;
    const memory: ProjectMemoryPort = {
      async recall(args) {
        recalls++;
        assert.equal(args.project, "synrex");
        return { status: "ok", project: "synrex", bytes: 52, items: [{
          id: "m1", source: "project", evidenceRef: "l3:abc",
          content: "Historical note: use versioned checkpoints",
        }] };
      },
      async hydrate() { return { status: "disabled", reason: "not needed" }; },
    };
    let semanticCount = 0;
    const semantic = {
      available: true,
      async call() {
        semanticCount++;
        return { result: "Serena get_symbols_overview: recoverSession", truncated: false, backendAgeMs: 0 };
      },
    };
    const contexts = new LocalAgentContextPacks(state, memory, semantic);
    const request = {
      workflowId: created.workflowId,
      memoryProject: "synrex",
      files: ["src/recovery.ts", "src/duplicate.ts", ".env", "src/escape.ts"],
      maxBytes: 4_000,
    };
    const first = await contexts.build({ workspaceRoot: repo, query: "Fix recoverSession", request });
    assert.ok(first.pack.bytes <= 4_000);
    assert.match(first.pack.rendered, /recoverSession/);
    assert.match(first.pack.rendered, /Historical note/);
    assert.match(first.pack.rendered, /Preserve existing interfaces/);
    assert.equal(first.pack.sources.some((item) => item.path === ".env"), false);
    assert.equal(first.pack.sources.some((item) => item.path === "src/escape.ts"), false);
    assert.equal(first.pack.sources.filter((item) => item.sha256 === first.pack.sources[0]?.sha256).length, 1);
    assert.ok(first.metrics.filesRead >= 1);
    assert.ok(first.metrics.semanticCalls >= 1);
    assert.ok(semanticCount >= 1);
    assert.equal(recalls, 1);
    const second = await contexts.build({ workspaceRoot: repo, query: "Fix recoverSession", request });
    assert.equal(second.pack.ref, first.pack.ref);
    assert.equal(second.metrics.filesRead, 0);
    assert.ok(second.metrics.sourceCacheHits >= 1);
    assert.equal(second.metrics.packReused, true);
    assert.equal(contexts.read(first.pack.ref, repo).ref, first.pack.ref);
    assert.throws(() => contexts.read("ctx_" + "f".repeat(64), repo));
    const other = mkdtempSync(join(temp, "other-"));
    assert.throws(() => contexts.read(first.pack.ref, other), /different workspace/);
    assert.equal((await contexts.build({
      workspaceRoot: repo, query: "handoff", request: { contextRef: first.pack.ref },
    })).pack.ref, first.pack.ref);
    await assert.rejects(() => contexts.build({
      workspaceRoot: repo, query: "invalid", request: { files: ["../outside.ts"] },
    }), /Invalid context file hint/);

    // Same-sized edit with an explicit new mtime: index must invalidate.
    writeFileSync(source, [
      "export function recoverSession() {",
      "  return 'new';",
      "}",
      "export interface SessionState {",
      "  revision: number;",
      "}",
    ].join("\n"));
    const future = new Date(Date.now() + 5_000);
    utimesSync(source, future, future);
    assert.throws(() => contexts.read(first.pack.ref, repo), /stale/);
    const updated = await contexts.build({ workspaceRoot: repo, query: "Fix recoverSession", request });
    assert.notEqual(updated.pack.ref, first.pack.ref);
    assert.ok(updated.metrics.filesRead >= 1);
    assert.match(updated.pack.rendered, /return 'new'/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("MemHub outage degrades without blocking a code context pack", async () => {
  const temp = mkdtempSync(join(tmpdir(), "synrex-context-degraded-"));
  try {
    git(temp, "init", "-q");
    writeFileSync(join(temp, "index.ts"), "export function foo() { return 1; }");
    git(temp, "add", "index.ts");
    git(temp, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture");
    const contexts = new LocalAgentContextPacks(join(temp, "state"), {
      async recall() { throw new Error("MemHub unavailable"); },
      async hydrate() { throw new Error("unavailable"); },
    });
    const pack = await contexts.build({
      workspaceRoot: temp, query: "foo",
      request: { memoryProject: "synrex", files: ["index.ts"] },
    });
    assert.equal(pack.pack.memory.status, "unavailable");
    assert.match(pack.pack.rendered, /index.ts/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
