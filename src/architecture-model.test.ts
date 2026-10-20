import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchitectureModelManager } from "./architecture-model.js";
import { SerenaSemanticManager } from "./serena-semantic.js";

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

  const architectureChange = await manager.openChange(root, "Document stable arithmetic boundary", [], {
    architectureChange: true,
    rationale: "Make the intended module contract explicit and durable.",
  });
  await manager.annotate(root, "src/a.ts", {
    summary: "Public arithmetic entry point",
    contracts: [{ kind: "note", text: "Must depend only on stable local modules" }],
    tags: ["core"],
  }, architectureChange.id);
  await manager.closeChange(root, architectureChange.id);
  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b + 2;\n');
  const drift = await manager.validate(root);
  assert.ok(drift.some((issue) => issue.code === "content-drift" && issue.moduleId === "file:src/a"));

  const refreshed = await manager.refresh(root);
  const refreshedA = refreshed.modules.find((module) => module.id === "file:src/a");
  assert.equal(refreshedA?.summary, "Public arithmetic entry point");
  assert.deepEqual(refreshedA?.contracts, [{ kind: "note", text: "Must depend only on stable local modules" }]);
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

test("architecture intent is protected from ordinary implementation changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-protected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "entry.ts"), "export const value = 1;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const change = await manager.openChange(root, "Refactor implementation", ["src/entry.ts"]);

  const intentPath = join(root, ".devspace-architecture.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8")) as {
    annotations: Array<{ target: string; summary?: string }>;
  };
  intent.annotations.push({ target: "src/entry.ts", summary: "Silently changed design" });
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

  await assert.rejects(
    () => manager.closeChange(root, change.id),
    /Architecture intent changed during an implementation change/,
  );
  const issues = await manager.conformance(root);
  assert.ok(issues.some((issue) => issue.code === "uncommitted-architecture-change"));
});

test("explicit architecture changes require rationale and can update enforceable policies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  await assert.rejects(
    () => manager.openChange(root, "Change architecture", [], { architectureChange: true }),
    /require a rationale/,
  );

  const change = await manager.openChange(root, "Protect module boundary", [], {
    architectureChange: true,
    rationale: "Keep a.ts independent from b.ts.",
  });
  await manager.updatePolicy(root, change.id, {
    dependencyRules: [{ kind: "forbid_dependency", from: "src/a.ts", to: "src/b.ts" }],
  });
  await manager.closeChange(root, change.id);
  assert.equal((await manager.conformance(root)).filter((issue) => issue.severity === "error").length, 0);

  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  const issues = await manager.conformance(root);
  assert.ok(issues.some((issue) => issue.code === "forbidden-dependency"));
});

test("ordinary source additions do not count as architecture intent changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-source-add-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
  const issues = await manager.conformance(root);
  assert.equal(issues.some((issue) => issue.code === "uncommitted-architecture-change"), false);
});

test("observed dependencies cover conservative local Python and C++ imports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-polyglot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pkg"), { recursive: true });
  await mkdir(join(root, "cpp"), { recursive: true });
  await writeFile(join(root, "pkg", "a.py"), "from .b import value\n");
  await writeFile(join(root, "pkg", "b.py"), "value = 1\n");
  await writeFile(join(root, "cpp", "a.cpp"), '#include "b.hpp"\nint main() { return value(); }\n');
  await writeFile(join(root, "cpp", "b.hpp"), "inline int value() { return 1; }\n");

  const model = await new ArchitectureModelManager().initialize(root);
  assert.deepEqual(
    model.modules.find((module) => module.path === "pkg/a.py")?.dependencies,
    ["file:pkg/b"],
  );
  assert.deepEqual(
    model.modules.find((module) => module.path === "cpp/a.cpp")?.dependencies,
    ["file:cpp/b"],
  );
});

test("same-stem files in polyglot repositories receive unambiguous module ids", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-polyglot-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "shared.js"), "export const js = 1;\n");
  await writeFile(join(root, "src", "shared.ts"), "export const ts = 2;\n");
  await writeFile(join(root, "src", "consumer.ts"), 'import { ts } from "./shared.js";\nexport const value = ts;\n');

  const manager = new ArchitectureModelManager();
  const model = await manager.initialize(root);
  const js = model.modules.find((module) => module.path === "src/shared.js");
  const ts = model.modules.find((module) => module.path === "src/shared.ts");
  assert.equal(js?.id, "file:src/shared.js");
  assert.equal(ts?.id, "file:src/shared.ts");
  assert.notEqual(js?.id, ts?.id);
  assert.equal((await manager.validate(root, model)).some((issue) => issue.code === "duplicate-id"), false);
});

test("nested projects do not inherit a parent Git repository for source discovery", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-architecture-parent-git-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, ".devspace", "benchmarks", "nested-project");
  await mkdir(join(project, "src", "domain"), { recursive: true });
  await mkdir(join(project, "src", "adapters"), { recursive: true });
  await writeFile(join(parent, ".gitignore"), ".devspace/\n");
  await writeFile(join(project, "src", "adapters", "inventory.js"), "export const available = () => 1;\n");
  await writeFile(join(project, "src", "domain", "order.js"), 'import { available } from "../adapters/inventory.js";\nexport const value = available();\n');
  await writeFile(join(project, ".devspace-architecture.json"), `${JSON.stringify({
    version: 1,
    project: "nested-project",
    policies: {
      acyclic: false,
      maxDepth: 12,
      dependencyRules: [{ kind: "forbid_dependency", from: "src/domain/**", to: "src/adapters/**" }],
    },
    annotations: [],
  }, null, 2)}\n`);

  const { git } = await import("./git.js");
  await git(parent, ["init"]);
  await git(parent, ["config", "user.email", "devspace@example.com"]);
  await git(parent, ["config", "user.name", "DevSpace Test"]);
  await git(parent, ["add", ".gitignore"]);
  await git(parent, ["commit", "-m", "Parent repository"]);

  const manager = new ArchitectureModelManager();
  const model = await manager.initialize(project);
  assert.ok(model.modules.some((module) => module.path === "src/domain/order.js"));
  assert.equal(model.revision.head, undefined, "nested project must not inherit the parent repository revision");
  const issues = await manager.conformance(project);
  assert.ok(issues.some((issue) => issue.code === "forbidden-dependency"));
});

test("module dependency contracts are executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const change = await manager.openChange(root, "Protect a from b", [], {
    architectureChange: true,
    rationale: "Keep the boundary executable rather than documentary.",
  });
  await manager.annotate(root, "src/a.ts", {
    contracts: [{ kind: "forbid_dependency", to: "src/b.ts" }],
  }, change.id);
  await manager.closeChange(root, change.id);

  await writeFile(join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  const issues = await manager.conformance(root);
  assert.ok(issues.some((issue) => issue.code === "contract-forbidden-dependency"));
});

test("fresh local governance state anchors tracked intent to Git HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-head-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const { git } = await import("./git.js");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "src/a.ts", ".devspace-architecture.json"]);
  await git(root, ["commit", "-m", "Baseline architecture"]);
  await rm(join(root, ".devspace"), { recursive: true, force: true });

  const intentPath = join(root, ".devspace-architecture.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8")) as {
    annotations: Array<{ target: string; summary?: string; contracts: unknown[]; tags: string[] }>;
  };
  intent.annotations.push({ target: "src/a.ts", summary: "Unreviewed redesign", contracts: [], tags: [] });
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

  const freshManager = new ArchitectureModelManager();
  const issues = await freshManager.conformance(root);
  assert.ok(issues.some((issue) => issue.code === "uncommitted-architecture-change"));
});

test("committed architecture intent from a branch update becomes the trusted baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-committed-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

  const { git } = await import("./git.js");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  await git(root, ["add", "src/a.ts", ".devspace-architecture.json"]);
  await git(root, ["commit", "-m", "Baseline architecture"]);
  await manager.conformance(root);

  const intentPath = join(root, ".devspace-architecture.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8")) as {
    annotations: Array<{ target: string; summary?: string; contracts: unknown[]; tags: string[] }>;
  };
  intent.annotations.push({ target: "src/a.ts", summary: "Committed design update", contracts: [], tags: [] });
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  await git(root, ["add", ".devspace-architecture.json"]);
  await git(root, ["commit", "-m", "Update architecture intent"]);

  const issues = await manager.conformance(root);
  assert.equal(issues.some((issue) => issue.code === "uncommitted-architecture-change"), false);
});

test("reinitialize preserves an explicitly approved uncommitted architecture change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-approved-reinit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const change = await manager.openChange(root, "Document a", [], {
    architectureChange: true,
    rationale: "Make the approved design survive a harmless reinitialization.",
  });
  await manager.annotate(root, "src/a.ts", {
    summary: "Approved architecture summary",
  }, change.id);
  await manager.closeChange(root, change.id);

  await manager.initialize(root);
  const issues = await manager.conformance(root);
  assert.equal(issues.some((issue) => issue.code === "uncommitted-architecture-change"), false);
});

test("empty semantic diagnostic objects do not create false warnings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-architecture-semantic-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");

  const baseManager = new ArchitectureModelManager();
  await baseManager.initialize(root);
  const change = await baseManager.openChange(root, "Protect a from b", [], {
    architectureChange: true,
    rationale: "Exercise semantic evidence only on governed files.",
  });
  await baseManager.updatePolicy(root, change.id, {
    dependencyRules: [{ kind: "forbid_dependency", from: "src/a.ts", to: "src/b.ts" }],
  });
  await baseManager.closeChange(root, change.id);
  await writeFile(join(root, "src", "a.ts"), "export const a = 3;\n");

  const semantic = new SerenaSemanticManager({
    available: true,
    createClient: async () => ({
      callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
      close: async () => undefined,
    }),
  });
  t.after(() => semantic.close());
  const issues = await new ArchitectureModelManager({ semantic }).conformance(root, { semantic: true });
  assert.equal(issues.some((issue) => issue.code === "semantic-diagnostics"), false);
});
