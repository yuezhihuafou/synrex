import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchitectureModelManager } from "./architecture-model.js";

test("architecture model refreshes code facts while preserving durable annotations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b + 1;\n');
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");

  const manager = new ArchitectureModelManager();
  const initial = await manager.initialize(root);
  const a = initial.modules.find((module) => module.id === "file:src/a");
  const b = initial.modules.find((module) => module.id === "file:src/b");
  assert.ok(a);
  assert.ok(b);
  assert.deepEqual(a.dependencies, ["file:src/b"]);

  await manager.annotate(root, "src/a.ts", {
    summary: "Public arithmetic entry point",
    contracts: ["Must depend only on stable local modules"],
    tags: ["core"],
  });
  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b + 2;\n');
  const drift = await manager.validate(root);
  assert.ok(drift.some((issue) => issue.code === "content-drift" && issue.moduleId === "file:src/a"));

  const refreshed = await manager.refresh(root);
  const refreshedA = refreshed.modules.find((module) => module.id === "file:src/a");
  assert.equal(refreshedA?.summary, "Public arithmetic entry point");
  assert.deepEqual(refreshedA?.contracts, ["Must depend only on stable local modules"]);
  assert.deepEqual(refreshedA?.tags, ["core"]);
  assert.equal((await manager.validate(root)).filter((issue) => issue.severity === "error").length, 0);

  const impacted = await manager.affected(root, ["src/b.ts"]);
  assert.ok(impacted.modules.some((module) => module.id === "file:src/b"));
  assert.ok(impacted.modules.some((module) => module.id === "file:src/a"));

  await rename(join(root, "src", "b.ts"), join(root, "src", "core.ts"));
  const renamed = await manager.refresh(root);
  assert.equal(renamed.modules.find((module) => module.id === "file:src/core")?.uid, b.uid);
});

test("architecture change close refreshes, validates, freezes, and renders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"), "export const value = 1;\n");
  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const change = await manager.openChange(root, "Change entry behavior", ["src/entry.ts"]);
  await writeFile(join(root, "src", "entry.ts"), "export const value = 2;\n");
  const closed = await manager.closeChange(root, change.id);
  assert.equal(closed.change.status, "verified");
  assert.equal(closed.issues.filter((issue) => issue.severity === "error").length, 0);
  const markdown = await readFile(join(root, ".devspace", "architecture", "ARCHITECTURE.md"), "utf8");
  const html = await readFile(join(root, ".devspace", "architecture", "architecture.html"), "utf8");
  assert.match(markdown, /entry\.ts/);
  assert.match(html, /entry\.ts/);
});
