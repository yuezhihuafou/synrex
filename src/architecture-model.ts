import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

const ARCHITECTURE_DIR = ".devspace/architecture";
const MODEL_FILE = "model.json";
const RENDER_MD = "ARCHITECTURE.md";
const RENDER_HTML = "architecture.html";
const CHANGES_DIR = "changes";
const MODEL_VERSION = 1 as const;
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".rb", ".php", ".swift", ".scala", ".vue", ".svelte",
]);
const IGNORED_PARTS = new Set([".git", ".devspace", "node_modules", "dist", "build", "coverage"]);

export type ArchitectureModuleKind = "group" | "file";

export interface ArchitectureModule {
  id: string;
  uid: string;
  kind: ArchitectureModuleKind;
  path: string;
  parentId?: string;
  summary?: string;
  contracts: string[];
  tags: string[];
  dependencies: string[];
  contentHash?: string;
}

export interface ArchitecturePolicy {
  acyclic: boolean;
  maxDepth: number;
  forbiddenDependencies: Array<{ from: string; to: string }>;
}

export interface ArchitectureModel {
  version: typeof MODEL_VERSION;
  project: string;
  generatedAt: string;
  revision: {
    head?: string;
    workingTreeFingerprint?: string;
  };
  policies: ArchitecturePolicy;
  modules: ArchitectureModule[];
}

export interface ArchitectureIssue {
  severity: "error" | "warning";
  code: string;
  moduleId?: string;
  message: string;
}

export interface ArchitectureChangeRecord {
  id: string;
  intent: string;
  status: "open" | "verified";
  openedAt: string;
  closedAt?: string;
  baselineHead?: string;
  afterHead?: string;
  requestedPaths: string[];
  affectedModules: string[];
}

export class ArchitectureModelManager {
  async initialize(root: string): Promise<ArchitectureModel> {
    const existing = await this.tryLoad(root);
    const model = await this.buildModel(root, existing);
    await this.save(root, model);
    await this.render(root, model);
    return model;
  }

  async refresh(root: string): Promise<ArchitectureModel> {
    const model = await this.buildModel(root, await this.tryLoad(root));
    await this.save(root, model);
    return model;
  }

  async loadOrInitialize(root: string): Promise<ArchitectureModel> {
    return await this.tryLoad(root) ?? this.initialize(root);
  }

  async annotate(
    root: string,
    target: string,
    input: { summary?: string; contracts?: string[]; tags?: string[] },
  ): Promise<ArchitectureModule> {
    const model = await this.loadOrInitialize(root);
    const module = findModule(model, target);
    if (!module) throw new Error(`Unknown architecture module: ${target}`);
    if (input.summary !== undefined) module.summary = input.summary.trim() || undefined;
    if (input.contracts !== undefined) module.contracts = uniqueStrings(input.contracts);
    if (input.tags !== undefined) module.tags = uniqueStrings(input.tags);
    model.generatedAt = new Date().toISOString();
    await this.save(root, model);
    return module;
  }

  async validate(root: string, model?: ArchitectureModel): Promise<ArchitectureIssue[]> {
    model ??= await this.loadOrInitialize(root);
    const issues: ArchitectureIssue[] = [];
    const ids = new Set<string>();
    const uids = new Set<string>();
    const modulesById = new Map(model.modules.map((module) => [module.id, module]));

    for (const module of model.modules) {
      if (ids.has(module.id)) issues.push(issue("error", "duplicate-id", module, `Duplicate module id ${module.id}.`));
      ids.add(module.id);
      if (uids.has(module.uid)) issues.push(issue("error", "duplicate-uid", module, `Duplicate module uid ${module.uid}.`));
      uids.add(module.uid);
      if (module.parentId && !modulesById.has(module.parentId)) {
        issues.push(issue("error", "missing-parent", module, `Parent ${module.parentId} does not exist.`));
      }
      for (const dependency of module.dependencies) {
        if (!modulesById.has(dependency)) {
          issues.push(issue("error", "missing-dependency", module, `Dependency ${dependency} does not exist.`));
        }
      }
      if (module.path.split("/").length > model.policies.maxDepth) {
        issues.push(issue("error", "max-depth", module, `Module depth exceeds maxDepth=${model.policies.maxDepth}.`));
      }
    }

    for (const module of model.modules.filter((candidate) => candidate.kind === "file")) {
      const absolute = path.join(root, ...module.path.split("/"));
      try {
        const content = await readFile(absolute);
        const hash = sha256(content);
        if (module.contentHash !== hash) {
          issues.push(issue("error", "content-drift", module, `${module.path} changed since architecture refresh.`));
        }
      } catch {
        issues.push(issue("error", "missing-file", module, `${module.path} no longer exists.`));
      }
    }

    const cycles = dependencyCycles(model.modules);
    for (const cycle of cycles) {
      issues.push({
        severity: model.policies.acyclic ? "error" : "warning",
        code: "dependency-cycle",
        message: `Dependency cycle: ${cycle.join(" -> ")}`,
      });
    }

    for (const module of model.modules) {
      for (const dependencyId of module.dependencies) {
        const dependency = modulesById.get(dependencyId);
        if (!dependency) continue;
        for (const rule of model.policies.forbiddenDependencies) {
          if (globMatch(module.path, rule.from) && globMatch(dependency.path, rule.to)) {
            issues.push(issue(
              "error",
              "forbidden-dependency",
              module,
              `${module.path} -> ${dependency.path} violates ${rule.from} -> ${rule.to}.`,
            ));
          }
        }
      }
    }

    return issues;
  }

  async brief(root: string, target: string): Promise<{
    module: ArchitectureModule;
    dependents: ArchitectureModule[];
    issues: ArchitectureIssue[];
  }> {
    const model = await this.loadOrInitialize(root);
    const module = findModule(model, target);
    if (!module) throw new Error(`Unknown architecture module: ${target}`);
    const dependents = model.modules.filter((candidate) => candidate.dependencies.includes(module.id));
    const allIssues = await this.validate(root, model);
    return {
      module,
      dependents,
      issues: allIssues.filter((candidate) => candidate.moduleId === module.id),
    };
  }

  async affected(root: string, requestedPaths?: string[]): Promise<{
    changedPaths: string[];
    modules: ArchitectureModule[];
  }> {
    const model = await this.loadOrInitialize(root);
    const changedPaths = uniqueStrings(
      (requestedPaths?.length ? requestedPaths : await gitChangedPaths(root)).map(normalizeRelativePath),
    );
    const seed = new Set<string>();
    for (const changedPath of changedPaths) {
      for (const module of model.modules) {
        if (
          module.path === changedPath
          || (module.kind === "group" && changedPath.startsWith(`${module.path}/`))
        ) seed.add(module.id);
      }
    }

    const reverse = new Map<string, string[]>();
    for (const module of model.modules) {
      for (const dependency of module.dependencies) {
        const list = reverse.get(dependency) ?? [];
        list.push(module.id);
        reverse.set(dependency, list);
      }
    }
    const affected = new Set(seed);
    const queue = [...seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dependent of reverse.get(current) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    return {
      changedPaths,
      modules: model.modules.filter((module) => affected.has(module.id)),
    };
  }

  async openChange(
    root: string,
    intent: string,
    requestedPaths: string[] = [],
  ): Promise<ArchitectureChangeRecord> {
    const model = await this.loadOrInitialize(root);
    const affected = await this.affected(root, requestedPaths.length > 0 ? requestedPaths : undefined);
    const record: ArchitectureChangeRecord = {
      id: `chg_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      intent: intent.trim(),
      status: "open",
      openedAt: new Date().toISOString(),
      baselineHead: model.revision.head,
      requestedPaths: affected.changedPaths,
      affectedModules: affected.modules.map((module) => module.id),
    };
    await this.writeChange(root, record);
    return record;
  }

  async closeChange(root: string, changeId: string): Promise<{
    change: ArchitectureChangeRecord;
    issues: ArchitectureIssue[];
  }> {
    const change = await this.readChange(root, changeId);
    if (change.status === "verified") {
      return { change, issues: await this.validate(root) };
    }
    const model = await this.refresh(root);
    const issues = await this.validate(root, model);
    const errors = issues.filter((candidate) => candidate.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Architecture freeze failed with ${errors.length} error(s): ${errors.slice(0, 5).map((item) => item.message).join(" | ")}`);
    }
    change.status = "verified";
    change.closedAt = new Date().toISOString();
    change.afterHead = model.revision.head;
    await this.writeChange(root, change);
    await this.render(root, model);
    return { change, issues };
  }

  async render(root: string, model?: ArchitectureModel): Promise<{
    markdownPath: string;
    htmlPath: string;
  }> {
    model ??= await this.loadOrInitialize(root);
    const base = path.join(root, ARCHITECTURE_DIR);
    await mkdir(base, { recursive: true });
    const markdownPath = path.join(base, RENDER_MD);
    const htmlPath = path.join(base, RENDER_HTML);
    await Promise.all([
      atomicWrite(markdownPath, renderMarkdown(model)),
      atomicWrite(htmlPath, renderHtml(model)),
    ]);
    return {
      markdownPath: normalizeRelativePath(path.relative(root, markdownPath)),
      htmlPath: normalizeRelativePath(path.relative(root, htmlPath)),
    };
  }

  private async buildModel(root: string, existing?: ArchitectureModel): Promise<ArchitectureModel> {
    const files = await sourceFiles(root);
    const existingByPath = new Map((existing?.modules ?? []).map((module) => [module.path, module]));
    const missingByHash = new Map<string, ArchitectureModule[]>();
    for (const module of existing?.modules ?? []) {
      if (module.kind !== "file" || !module.contentHash || files.includes(module.path)) continue;
      const list = missingByHash.get(module.contentHash) ?? [];
      list.push(module);
      missingByHash.set(module.contentHash, list);
    }

    const contents = new Map<string, string>();
    const hashes = new Map<string, string>();
    for (const relativePath of files) {
      const content = await readFile(path.join(root, ...relativePath.split("/")), "utf8");
      contents.set(relativePath, content);
      hashes.set(relativePath, sha256(content));
    }
    const fileSet = new Set(files);
    const modules: ArchitectureModule[] = [];
    const groups = new Set<string>();
    for (const relativePath of files) {
      let directory = normalizeRelativePath(path.posix.dirname(relativePath));
      while (directory && directory !== ".") {
        groups.add(directory);
        const parent = normalizeRelativePath(path.posix.dirname(directory));
        if (!parent || parent === ".") break;
        directory = parent;
      }
    }

    for (const groupPath of [...groups].sort()) {
      const id = `group:${groupPath}`;
      const old = existingByPath.get(groupPath);
      modules.push({
        id,
        uid: old?.kind === "group" ? old.uid : stableUid("group", groupPath),
        kind: "group",
        path: groupPath,
        parentId: parentGroupId(groupPath),
        summary: old?.kind === "group" ? old.summary : undefined,
        contracts: old?.kind === "group" ? old.contracts : [],
        tags: old?.kind === "group" ? old.tags : [],
        dependencies: [],
      });
    }

    for (const relativePath of files) {
      const hash = hashes.get(relativePath)!;
      const oldAtPath = existingByPath.get(relativePath);
      const renamed = oldAtPath?.kind === "file"
        ? undefined
        : (missingByHash.get(hash) ?? []).shift();
      const old = oldAtPath?.kind === "file" ? oldAtPath : renamed;
      modules.push({
        id: fileModuleId(relativePath),
        uid: old?.uid ?? stableUid("file", relativePath),
        kind: "file",
        path: relativePath,
        parentId: parentGroupId(relativePath),
        summary: old?.summary,
        contracts: old?.contracts ?? [],
        tags: old?.tags ?? [],
        dependencies: inferDependencies(relativePath, contents.get(relativePath) ?? "", fileSet),
        contentHash: hash,
      });
    }

    const revision = await gitRevision(root);
    return {
      version: MODEL_VERSION,
      project: path.basename(root),
      generatedAt: new Date().toISOString(),
      revision,
      policies: existing?.policies ?? {
        acyclic: false,
        maxDepth: 12,
        forbiddenDependencies: [],
      },
      modules: modules.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)),
    };
  }

  private async tryLoad(root: string): Promise<ArchitectureModel | undefined> {
    const file = path.join(root, ARCHITECTURE_DIR, MODEL_FILE);
    try {
      await access(file);
    } catch {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as ArchitectureModel;
    if (parsed.version !== MODEL_VERSION || !Array.isArray(parsed.modules)) {
      throw new Error(`Unsupported architecture model at ${normalizeRelativePath(path.relative(root, file))}.`);
    }
    return parsed;
  }

  private async save(root: string, model: ArchitectureModel): Promise<void> {
    const file = path.join(root, ARCHITECTURE_DIR, MODEL_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, `${JSON.stringify(model, null, 2)}\n`);
  }

  private async writeChange(root: string, change: ArchitectureChangeRecord): Promise<void> {
    const file = path.join(root, ARCHITECTURE_DIR, CHANGES_DIR, `${safeId(change.id)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, `${JSON.stringify(change, null, 2)}\n`);
  }

  private async readChange(root: string, changeId: string): Promise<ArchitectureChangeRecord> {
    const file = path.join(root, ARCHITECTURE_DIR, CHANGES_DIR, `${safeId(changeId)}.json`);
    try {
      return JSON.parse(await readFile(file, "utf8")) as ArchitectureChangeRecord;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unknown architecture change ${changeId}: ${detail}`);
    }
  }
}

function issue(
  severity: ArchitectureIssue["severity"],
  code: string,
  module: ArchitectureModule,
  message: string,
): ArchitectureIssue {
  return { severity, code, moduleId: module.id, message };
}

function findModule(model: ArchitectureModel, target: string): ArchitectureModule | undefined {
  const normalized = normalizeRelativePath(target.replace(/^\.\//, ""));
  return model.modules.find((module) => (
    module.id === target
    || module.path === normalized
    || (module.kind === "file" && module.id === `file:${stripSourceExtension(normalized)}`)
    || (module.kind === "group" && module.id === `group:${normalized}`)
  ));
}

function fileModuleId(relativePath: string): string {
  return `file:${stripSourceExtension(relativePath)}`;
}

function stripSourceExtension(relativePath: string): string {
  const extension = path.posix.extname(relativePath);
  return SOURCE_EXTENSIONS.has(extension) ? relativePath.slice(0, -extension.length) : relativePath;
}

function parentGroupId(relativePath: string): string | undefined {
  const directory = normalizeRelativePath(path.posix.dirname(relativePath));
  return !directory || directory === "." ? undefined : `group:${directory}`;
}

function stableUid(kind: ArchitectureModuleKind, relativePath: string): string {
  return createHash("sha256").update(`${kind}\0${relativePath}`).digest("hex").slice(0, 20);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceFiles(root: string): Promise<string[]> {
  let candidates: string[];
  try {
    const listed = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    candidates = listed.stdout.split("\0").filter(Boolean);
  } catch {
    candidates = await walkFiles(root);
  }
  return uniqueStrings(candidates.map(normalizeRelativePath))
    .filter((candidate) => isSourceFile(candidate) && !hasIgnoredPart(candidate))
    .sort();
}

async function walkFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_PARTS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(normalizeRelativePath(path.relative(root, absolute)));
    }
  }
  await visit(root);
  return output;
}

function isSourceFile(relativePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(relativePath));
}

function hasIgnoredPart(relativePath: string): boolean {
  return relativePath.split("/").some((part) => IGNORED_PARTS.has(part));
}

function inferDependencies(relativePath: string, content: string, files: Set<string>): string[] {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(path.posix.extname(relativePath))) return [];
  const specifiers = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.add(match[1]);
    }
  }
  const dependencies = new Set<string>();
  for (const specifier of specifiers) {
    const resolved = resolveRelativeImport(relativePath, specifier, files);
    if (resolved && resolved !== relativePath) dependencies.add(fileModuleId(resolved));
  }
  return [...dependencies].sort();
}

function resolveRelativeImport(from: string, specifier: string, files: Set<string>): string | undefined {
  const base = normalizeRelativePath(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const candidates = [base];
  const ext = path.posix.extname(base);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stem = base.slice(0, -ext.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`);
  } else if (!ext) {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  }
  return candidates.find((candidate) => files.has(candidate));
}

async function gitRevision(root: string): Promise<ArchitectureModel["revision"]> {
  try {
    const [head, status] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"]),
      git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    return {
      head: head.stdout.trim(),
      workingTreeFingerprint: sha256(status.stdout),
    };
  } catch {
    return {};
  }
}

async function gitChangedPaths(root: string): Promise<string[]> {
  try {
    const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return status.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const body = line.slice(3).trim();
      if (!body) return [];
      const renamed = body.split(" -> ").at(-1) ?? body;
      return [renamed.replace(/^"|"$/g, "")];
    });
  } catch {
    return [];
  }
}

function dependencyCycles(modules: ArchitectureModule[]): string[][] {
  const files = modules.filter((module) => module.kind === "file");
  const byId = new Map(files.map((module) => [module.id, module]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, start)), id];
      const key = [...new Set(cycle)].sort().join("|");
      if (!cycles.has(key)) cycles.set(key, cycle);
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const module of files) visit(module.id);
  return [...cycles.values()];
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function renderMarkdown(model: ArchitectureModel): string {
  const children = childMap(model.modules);
  const lines = [
    `# ${model.project} architecture`,
    "",
    `Generated: ${model.generatedAt}`,
    model.revision.head ? `Revision: \`${model.revision.head}\`` : "Revision: non-Git workspace",
    "",
    "This file is generated from `.devspace/architecture/model.json`. Add durable intent with the DevSpace `architecture` tool; refresh regenerates code facts while preserving annotations.",
    "",
    "## Module tree",
    "",
  ];
  for (const module of model.modules.filter((candidate) => !candidate.parentId)) {
    renderMarkdownModule(module, children, lines, 0);
  }
  lines.push("", "## Policies", "");
  lines.push(`- acyclic: ${model.policies.acyclic}`);
  lines.push(`- maxDepth: ${model.policies.maxDepth}`);
  for (const rule of model.policies.forbiddenDependencies) lines.push(`- forbid: \`${rule.from}\` -> \`${rule.to}\``);
  lines.push("");
  return lines.join("\n");
}

function renderMarkdownModule(
  module: ArchitectureModule,
  children: Map<string | undefined, ArchitectureModule[]>,
  lines: string[],
  depth: number,
): void {
  const indent = "  ".repeat(depth);
  const summary = module.summary ? ` — ${module.summary}` : "";
  const contracts = module.contracts.length > 0 ? ` [contracts: ${module.contracts.join("; ")}]` : "";
  lines.push(`${indent}- **${module.path}** (${module.kind})${summary}${contracts}`);
  for (const child of children.get(module.id) ?? []) renderMarkdownModule(child, children, lines, depth + 1);
}

function renderHtml(model: ArchitectureModel): string {
  const payload = JSON.stringify(model).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(model.project)} architecture</title>
<style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px}input{width:100%;box-sizing:border-box;padding:10px;margin:12px 0 20px}.m{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:8px 0}.p{font-family:ui-monospace,monospace}.muted{opacity:.65}.tag{display:inline-block;border:1px solid #ccc;border-radius:999px;padding:1px 7px;margin-right:5px}</style>
</head><body><h1>${escapeHtml(model.project)} architecture</h1><div class="muted">Generated ${escapeHtml(model.generatedAt)}</div><input id="q" placeholder="Filter path, summary, contract, tag"><div id="list"></div>
<script>const model=${payload};const list=document.getElementById('list'),q=document.getElementById('q');function e(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function draw(){const x=q.value.toLowerCase();list.innerHTML=model.modules.filter(m=>JSON.stringify(m).toLowerCase().includes(x)).map(m=>'<div class="m"><div class="p"><b>'+e(m.path)+'</b> <span class="muted">'+e(m.kind)+'</span></div>'+(m.summary?'<div>'+e(m.summary)+'</div>':'')+(m.contracts.length?'<div><b>contracts</b>: '+m.contracts.map(e).join('; ')+'</div>':'')+(m.dependencies.length?'<div class="muted">depends on '+m.dependencies.map(e).join(', ')+'</div>':'')+(m.tags.length?'<div>'+m.tags.map(t=>'<span class="tag">'+e(t)+'</span>').join('')+'</div>':'')+'</div>').join('')}q.addEventListener('input',draw);draw();</script></body></html>\n`;
}

function childMap(modules: ArchitectureModule[]): Map<string | undefined, ArchitectureModule[]> {
  const map = new Map<string | undefined, ArchitectureModule[]>();
  for (const module of modules) {
    const list = map.get(module.parentId) ?? [];
    list.push(module);
    map.set(module.parentId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  return map;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o644 });
  await rename(temp, file);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe architecture change id: ${value}`);
  return value;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
