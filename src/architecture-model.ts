import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ARCHITECTURE_INTENT_FILE,
  architectureIntentFingerprint,
  defaultArchitectureIntent,
  hasArchitectureIntent,
  loadArchitectureIntent,
  normalizeArchitectureIntent,
  saveArchitectureIntent,
  type ArchitectureContract,
  type ArchitectureIntent,
  type ArchitectureIntentAnnotation,
  type ArchitecturePolicy,
} from "./architecture-intent.js";
import { git } from "./git.js";
import type { SerenaSemanticManager } from "./serena-semantic.js";

const ARCHITECTURE_DIR = ".devspace/architecture";
const MODEL_FILE = "model.json";
const RENDER_MD = "ARCHITECTURE.md";
const RENDER_HTML = "architecture.html";
const CHANGES_DIR = "changes";
// v2 uses a new filename because the old lock hashed generated structure,
// which is not comparable with the versioned intended architecture.
const INTENT_LOCK_FILE = "intent-v2.sha256";
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
  contracts: ArchitectureContract[];
  tags: string[];
  dependencies: string[];
  contentHash?: string;
}

function intentFromLegacyModel(root: string, existing?: ArchitectureModel): ArchitectureIntent {
  const intent = defaultArchitectureIntent(path.basename(root));
  if (!existing) return intent;
  const legacyPolicies = existing.policies as unknown as {
    acyclic?: unknown;
    maxDepth?: unknown;
    dependencyRules?: unknown;
    forbiddenDependencies?: unknown;
  };
  if (typeof legacyPolicies.acyclic === "boolean") intent.policies.acyclic = legacyPolicies.acyclic;
  if (typeof legacyPolicies.maxDepth === "number" && Number.isInteger(legacyPolicies.maxDepth) && legacyPolicies.maxDepth > 0) {
    intent.policies.maxDepth = legacyPolicies.maxDepth;
  }
  if (Array.isArray(legacyPolicies.dependencyRules)) {
    intent.policies.dependencyRules = legacyPolicies.dependencyRules.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as { kind?: unknown; from?: unknown; to?: unknown };
      if ((item.kind !== "forbid_dependency" && item.kind !== "require_dependency") || typeof item.from !== "string" || typeof item.to !== "string") return [];
      return [{ kind: item.kind, from: item.from, to: item.to }];
    });
  } else if (Array.isArray(legacyPolicies.forbiddenDependencies)) {
    intent.policies.dependencyRules = legacyPolicies.forbiddenDependencies.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as { from?: unknown; to?: unknown };
      return typeof item.from === "string" && typeof item.to === "string"
        ? [{ kind: "forbid_dependency" as const, from: item.from, to: item.to }]
        : [];
    });
  }
  intent.annotations = existing.modules.flatMap((module) => {
    const legacyContracts = module.contracts as unknown;
    const contracts: ArchitectureContract[] = [];
    if (Array.isArray(legacyContracts)) {
      for (const value of legacyContracts) {
        if (typeof value === "string" && value.trim()) {
          contracts.push({ kind: "note", text: value.trim() });
          continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const item = value as { kind?: unknown; to?: unknown; text?: unknown };
        if (item.kind === "note" && typeof item.text === "string" && item.text.trim()) {
          contracts.push({ kind: "note", text: item.text.trim() });
        } else if ((item.kind === "forbid_dependency" || item.kind === "require_dependency") && typeof item.to === "string" && item.to.trim()) {
          contracts.push({ kind: item.kind, to: item.to.trim() });
        }
      }
    }
    if (!module.summary && contracts.length === 0 && module.tags.length === 0) return [];
    return [{
      target: module.path,
      summary: module.summary,
      contracts,
      tags: module.tags,
    } satisfies ArchitectureIntentAnnotation];
  });
  return intent;
}

async function initialIntentFingerprint(
  root: string,
  current: ArchitectureIntent,
): Promise<string> {
  return await committedIntentFingerprint(root) ?? architectureIntentFingerprint(current);
}

async function committedIntentFingerprint(root: string): Promise<string | undefined> {
  try {
    const gitRoot = await ownGitRepositoryRoot(root);
    if (!gitRoot) return undefined;
    const head = await git(gitRoot, ["show", `HEAD:${ARCHITECTURE_INTENT_FILE}`]);
    const committed = normalizeArchitectureIntent(
      JSON.parse(head.stdout) as unknown,
      path.basename(root),
    );
    return architectureIntentFingerprint(committed);
  } catch {
    return undefined;
  }
}

function upsertAnnotation(intent: ArchitectureIntent, target: string): ArchitectureIntentAnnotation {
  const existing = intent.annotations.find((candidate) => candidate.target === target);
  if (existing) return existing;
  const created: ArchitectureIntentAnnotation = { target, contracts: [], tags: [] };
  intent.annotations.push(created);
  intent.annotations.sort((a, b) => a.target.localeCompare(b.target));
  return created;
}

function validateDependencyRules(
  model: ArchitectureModel,
  modulesById: Map<string, ArchitectureModule>,
  issues: ArchitectureIssue[],
): void {
  const files = model.modules.filter((module) => module.kind === "file");
  for (const rule of model.policies.dependencyRules) {
    const sources = files.filter((module) => globMatch(module.path, rule.from));
    if (sources.length === 0) {
      issues.push({
        severity: "warning",
        code: "dependency-rule-no-source",
        message: `Architecture rule ${rule.kind} ${rule.from} -> ${rule.to} matches no source files.`,
      });
      continue;
    }
    for (const source of sources) {
      const matches = source.dependencies
        .map((dependencyId) => modulesById.get(dependencyId))
        .filter((dependency): dependency is ArchitectureModule => Boolean(dependency && globMatch(dependency.path, rule.to)));
      if (rule.kind === "forbid_dependency") {
        for (const dependency of matches) {
          issues.push(issue(
            "error",
            "forbidden-dependency",
            source,
            `${source.path} -> ${dependency.path} violates ${rule.from} -> ${rule.to}.`,
          ));
        }
      } else if (matches.length === 0) {
        issues.push(issue(
          "error",
          "required-dependency-missing",
          source,
          `${source.path} must depend on a module matching ${rule.to}.`,
        ));
      }
    }
  }
}

function validateModuleContracts(
  model: ArchitectureModel,
  modulesById: Map<string, ArchitectureModule>,
  issues: ArchitectureIssue[],
): void {
  const files = model.modules.filter((module) => module.kind === "file");
  for (const owner of model.modules) {
    const sources = owner.kind === "file"
      ? [owner]
      : files.filter((module) => module.path.startsWith(`${owner.path}/`));
    for (const contract of owner.contracts) {
      if (contract.kind === "note") continue;
      const matchingEdges = sources.flatMap((source) => source.dependencies.flatMap((dependencyId) => {
        const dependency = modulesById.get(dependencyId);
        return dependency && globMatch(dependency.path, contract.to) ? [{ source, dependency }] : [];
      }));
      if (contract.kind === "forbid_dependency") {
        for (const edge of matchingEdges) {
          issues.push(issue(
            "error",
            "contract-forbidden-dependency",
            owner,
            `${edge.source.path} -> ${edge.dependency.path} violates contract on ${owner.path}.`,
          ));
        }
      } else if (sources.length > 0 && matchingEdges.length === 0) {
        issues.push(issue(
          "error",
          "contract-required-dependency-missing",
          owner,
          `${owner.path} requires a dependency matching ${contract.to}.`,
        ));
      }
    }
  }
}

export type { ArchitectureContract, ArchitecturePolicy } from "./architecture-intent.js";

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
  kind: "implementation" | "architecture";
  rationale?: string;
  status: "open" | "verified";
  openedAt: string;
  closedAt?: string;
  baselineHead?: string;
  afterHead?: string;
  baselineIntentFingerprint?: string;
  afterIntentFingerprint?: string;
  requestedPaths: string[];
  affectedModules: string[];
}

export class ArchitectureModelManager {
  constructor(private readonly options: { semantic?: SerenaSemanticManager } = {}) {}

  async initialize(root: string): Promise<ArchitectureModel> {
    const existing = await this.tryLoad(root);
    let intent = await loadArchitectureIntent(root);
    if (!intent) {
      intent = intentFromLegacyModel(root, existing);
      await saveArchitectureIntent(root, intent);
    }
    const model = await this.buildModel(root, intent, existing);
    await this.save(root, model);
    if (!(await this.readIntentLock(root))) {
      await this.writeIntentLock(root, await initialIntentFingerprint(root, intent));
    }
    await this.render(root, model);
    return model;
  }

  async refresh(root: string): Promise<ArchitectureModel> {
    const existing = await this.tryLoad(root);
    const intent = await loadArchitectureIntent(root) ?? intentFromLegacyModel(root, existing);
    if (!(await hasArchitectureIntent(root))) await saveArchitectureIntent(root, intent);
    const model = await this.buildModel(root, intent, existing);
    await this.save(root, model);
    if (!(await this.readIntentLock(root))) {
      await this.writeIntentLock(root, await initialIntentFingerprint(root, intent));
    }
    return model;
  }

  async loadOrInitialize(root: string): Promise<ArchitectureModel> {
    return await this.tryLoad(root) ?? this.initialize(root);
  }

  async annotate(
    root: string,
    target: string,
    input: { summary?: string; contracts?: ArchitectureContract[]; tags?: string[] },
    changeId: string,
  ): Promise<ArchitectureModule> {
    await this.assertArchitectureChange(root, changeId);
    const model = await this.loadOrInitialize(root);
    const module = findModule(model, target);
    if (!module) throw new Error(`Unknown architecture module: ${target}`);
    const intent = await this.requireIntent(root);
    const annotation = upsertAnnotation(intent, module.path);
    if (input.summary !== undefined) annotation.summary = input.summary.trim() || undefined;
    if (input.contracts !== undefined) annotation.contracts = uniqueContracts(input.contracts);
    if (input.tags !== undefined) annotation.tags = uniqueStrings(input.tags);
    await saveArchitectureIntent(root, intent);
    const refreshed = await this.refresh(root);
    return findModule(refreshed, module.path)!;
  }

  async updatePolicy(
    root: string,
    changeId: string,
    input: Partial<ArchitecturePolicy>,
  ): Promise<ArchitecturePolicy> {
    await this.assertArchitectureChange(root, changeId);
    const intent = await this.requireIntent(root);
    intent.policies = {
      acyclic: input.acyclic ?? intent.policies.acyclic,
      maxDepth: input.maxDepth ?? intent.policies.maxDepth,
      dependencyRules: input.dependencyRules ?? intent.policies.dependencyRules,
    };
    if (!Number.isInteger(intent.policies.maxDepth) || intent.policies.maxDepth < 1) {
      throw new Error("Architecture maxDepth must be a positive integer.");
    }
    await saveArchitectureIntent(root, intent);
    return intent.policies;
  }

  async hasModel(root: string): Promise<boolean> {
    return (await hasArchitectureIntent(root)) || (await this.tryLoad(root)) !== undefined;
  }

  async conformance(
    root: string,
    options: { semantic?: boolean } = {},
  ): Promise<ArchitectureIssue[]> {
    const model = await this.refresh(root);
    const issues = await this.validate(root, model);
    const sealed = await this.readIntentLock(root);
    const current = architectureIntentFingerprint(await this.requireIntent(root));
    if (sealed && sealed !== current) {
      // A Git commit made by the same executing agent is not independent
      // architecture-change authority. Only a verified closeChange() for
      // kind=architecture can advance the trusted seal. This also detects
      // unreviewed branch switches containing a different intent.
      issues.unshift({
        severity: "error",
        code: "uncommitted-architecture-change",
        message: "Architecture intent differs from the last explicitly verified architecture change; a Git commit alone is not approval.",
      });
    }
    if (options.semantic) issues.push(...await this.semanticEvidenceIssues(root, model));
    return issues;
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

    if (model.policies.acyclic) {
      const cycles = dependencyCycles(model.modules);
      for (const cycle of cycles) {
        issues.push({
          severity: "error",
          code: "dependency-cycle",
          message: `Dependency cycle: ${cycle.join(" -> ")}`,
        });
      }
    }

    validateDependencyRules(model, modulesById, issues);
    validateModuleContracts(model, modulesById, issues);

    const intent = await loadArchitectureIntent(root);
    for (const annotation of intent?.annotations ?? []) {
      if (!model.modules.some((module) => module.path === annotation.target)) {
        issues.push({
          severity: "warning",
          code: "orphaned-architecture-annotation",
          message: `Architecture annotation target no longer exists: ${annotation.target}.`,
        });
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
    options: { architectureChange?: boolean; rationale?: string } = {},
  ): Promise<ArchitectureChangeRecord> {
    const model = await this.loadOrInitialize(root);
    const currentIntentFingerprint = architectureIntentFingerprint(await this.requireIntent(root));
    const sealedIntentFingerprint = await this.readIntentLock(root) ?? currentIntentFingerprint;
    if (!(await this.readIntentLock(root))) await this.writeIntentLock(root, sealedIntentFingerprint);
    if (currentIntentFingerprint !== sealedIntentFingerprint) {
      throw new Error("Architecture intent has uncommitted changes. Restore it or close the architecture change before opening another change.");
    }
    const kind = options.architectureChange ? "architecture" : "implementation";
    const rationale = options.rationale?.trim();
    if (kind === "architecture" && !rationale) {
      throw new Error("Architecture changes require a rationale.");
    }
    const affected = await this.affected(root, requestedPaths.length > 0 ? requestedPaths : undefined);
    const record: ArchitectureChangeRecord = {
      id: `chg_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      intent: intent.trim(),
      kind,
      ...(rationale ? { rationale } : {}),
      status: "open",
      openedAt: new Date().toISOString(),
      baselineHead: model.revision.head,
      baselineIntentFingerprint: sealedIntentFingerprint,
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
    await this.loadOrInitialize(root);
    const currentIntentFingerprint = architectureIntentFingerprint(await this.requireIntent(root));
    if (
      change.kind !== "architecture"
      && change.baselineIntentFingerprint
      && currentIntentFingerprint !== change.baselineIntentFingerprint
    ) {
      throw new Error("Architecture intent changed during an implementation change. Revert the design change or open an explicit architecture change with rationale.");
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
    change.afterIntentFingerprint = architectureIntentFingerprint(await this.requireIntent(root));
    if (change.kind === "architecture") {
      await this.writeIntentLock(root, change.afterIntentFingerprint);
    }
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

  private async buildModel(
    root: string,
    intent: ArchitectureIntent,
    existing?: ArchitectureModel,
  ): Promise<ArchitectureModel> {
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
      const annotation = intent.annotations.find((candidate) => candidate.target === groupPath);
      modules.push({
        id,
        uid: old?.kind === "group" ? old.uid : stableUid("group", groupPath),
        kind: "group",
        path: groupPath,
        parentId: parentGroupId(groupPath),
        summary: annotation?.summary,
        contracts: annotation?.contracts ?? [],
        tags: annotation?.tags ?? [],
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
      const annotation = intent.annotations.find((candidate) => candidate.target === relativePath);
      modules.push({
        id: fileModuleId(relativePath, fileSet),
        uid: old?.uid ?? stableUid("file", relativePath),
        kind: "file",
        path: relativePath,
        parentId: parentGroupId(relativePath),
        summary: annotation?.summary,
        contracts: annotation?.contracts ?? [],
        tags: annotation?.tags ?? [],
        dependencies: inferDependencies(relativePath, contents.get(relativePath) ?? "", fileSet),
        contentHash: hash,
      });
    }

    const revision = await gitRevision(root);
    return {
      version: MODEL_VERSION,
      project: intent.project,
      generatedAt: new Date().toISOString(),
      revision,
      policies: intent.policies,
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
      const parsed = JSON.parse(await readFile(file, "utf8")) as ArchitectureChangeRecord;
      return { ...parsed, kind: parsed.kind ?? "implementation" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unknown architecture change ${changeId}: ${detail}`);
    }
  }

  private async assertArchitectureChange(root: string, changeId: string): Promise<void> {
    const change = await this.readChange(root, changeId);
    if (change.status !== "open" || change.kind !== "architecture") {
      throw new Error("Architecture intent is protected. Open an architecture change with rationale before editing annotations or policies.");
    }
  }

  private async requireIntent(root: string): Promise<ArchitectureIntent> {
    const intent = await loadArchitectureIntent(root);
    if (intent) return intent;
    await this.initialize(root);
    const initialized = await loadArchitectureIntent(root);
    if (!initialized) throw new Error(`Failed to initialize ${ARCHITECTURE_INTENT_FILE}.`);
    return initialized;
  }

  private async semanticEvidenceIssues(root: string, model: ArchitectureModel): Promise<ArchitectureIssue[]> {
    const semantic = this.options.semantic;
    if (!semantic?.available) return [];
    const changed = new Set((await gitChangedPaths(root)).map(normalizeRelativePath));
    const files = model.modules
      .filter((module) => module.kind === "file" && changed.has(module.path))
      .filter((module) => (
        module.contracts.some((contract) => contract.kind !== "note")
        || model.policies.dependencyRules.some((rule) => globMatch(module.path, rule.from))
      ))
      .slice(0, 6);
    const checks = await Promise.all(files.map(async (module) => {
      try {
        const response = await semantic.call(root, "get_diagnostics_for_file", {
          relative_path: module.path,
          max_answer_chars: 2_000,
        }, { timeoutMs: 5_000 });
        const text = response.result.trim();
        if (semanticDiagnosticsEmpty(text)) return undefined;
        return issue(
          "warning",
          "semantic-diagnostics",
          module,
          `${module.path} has language-server diagnostics: ${compactLine(text, 320)}`,
        );
      } catch (error) {
        return issue(
          "warning",
          "semantic-verification-unavailable",
          module,
          `${module.path} could not be checked by the semantic backend: ${compactLine(error instanceof Error ? error.message : String(error), 240)}`,
        );
      }
    }));
    return checks.filter((value): value is ArchitectureIssue => value !== undefined);
  }

  private async readIntentLock(root: string): Promise<string | undefined> {
    try {
      const value = await readFile(path.join(root, ARCHITECTURE_DIR, INTENT_LOCK_FILE), "utf8");
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async writeIntentLock(root: string, fingerprint: string): Promise<void> {
    const file = path.join(root, ARCHITECTURE_DIR, INTENT_LOCK_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, `${fingerprint}\n`);
  }
}

function semanticDiagnosticsEmpty(value: string): boolean {
  if (!value || /no diagnostics/i.test(value)) return true;
  try {
    return structurallyEmpty(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function structurallyEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.every(structurallyEmpty);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(structurallyEmpty);
  return false;
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
  const exact = model.modules.find((module) => (
    module.id === target
    || module.path === normalized
    || (module.kind === "group" && module.id === `group:${normalized}`)
  ));
  if (exact) return exact;
  if (target.startsWith("file:")) {
    const legacy = model.modules.filter((module) => (
      module.kind === "file" && `file:${stripSourceExtension(module.path)}` === target
    ));
    return legacy.length === 1 ? legacy[0] : undefined;
  }
  return model.modules.find((module) => (
    module.kind === "file" && `file:${stripSourceExtension(module.path)}` === `file:${stripSourceExtension(normalized)}`
  ));
}

function fileModuleId(relativePath: string, files?: Set<string>): string {
  const stem = stripSourceExtension(relativePath);
  if (files) {
    const collides = [...files].some((candidate) => (
      candidate !== relativePath && stripSourceExtension(candidate) === stem
    ));
    if (collides) return `file:${relativePath}`;
  }
  return `file:${stem}`;
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
    const gitRoot = await ownGitRepositoryRoot(root);
    if (!gitRoot) throw new Error("Project root is not its own Git repository root.");
    const listed = await git(gitRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
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
  const extension = path.posix.extname(relativePath);
  if ([".py"].includes(extension)) return inferPythonDependencies(relativePath, content, files);
  if ([".c", ".h", ".cc", ".cpp", ".hpp"].includes(extension)) return inferCppDependencies(relativePath, content, files);
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return [];
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
    if (resolved && resolved !== relativePath) dependencies.add(fileModuleId(resolved, files));
  }
  return [...dependencies].sort();
}

function inferPythonDependencies(relativePath: string, content: string, files: Set<string>): string[] {
  const resolved = new Set<string>();
  const fromPattern = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+([^#\n]+)/gm;
  for (const match of content.matchAll(fromPattern)) {
    const dots = match[1]?.length ?? 0;
    const moduleName = match[2] ?? "";
    if (moduleName) {
      const dependency = resolvePythonImport(relativePath, dots, moduleName, files);
      if (dependency && dependency !== relativePath) resolved.add(dependency);
      continue;
    }
    if (dots === 0) continue;
    for (const imported of (match[3] ?? "").split(",")) {
      const name = imported.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name || name === "*" || !/^[A-Za-z_]\w*$/.test(name)) continue;
      const dependency = resolvePythonImport(relativePath, dots, name, files);
      if (dependency && dependency !== relativePath) resolved.add(dependency);
    }
  }
  const importPattern = /^\s*import\s+([^#\n]+)/gm;
  for (const match of content.matchAll(importPattern)) {
    for (const imported of (match[1] ?? "").split(",")) {
      const name = imported.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) continue;
      const dependency = resolvePythonImport(relativePath, 0, name, files);
      if (dependency && dependency !== relativePath) resolved.add(dependency);
    }
  }
  return [...resolved].sort().map((candidate) => fileModuleId(candidate, files));
}

function resolvePythonImport(
  from: string,
  leadingDots: number,
  moduleName: string,
  files: Set<string>,
): string | undefined {
  const modulePath = moduleName.replace(/\./g, "/");
  if (leadingDots > 0) {
    let base = path.posix.dirname(from);
    for (let index = 1; index < leadingDots; index += 1) base = path.posix.dirname(base);
    return resolvePythonCandidate(normalizeRelativePath(path.posix.join(base, modulePath)), files);
  }
  return resolvePythonCandidate(modulePath, files) ?? uniqueSuffixFile(files, [
    `/${modulePath}.py`,
    `/${modulePath}/__init__.py`,
  ]);
}

function resolvePythonCandidate(base: string, files: Set<string>): string | undefined {
  for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

function inferCppDependencies(relativePath: string, content: string, files: Set<string>): string[] {
  const resolved = new Set<string>();
  for (const match of content.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) {
    const include = match[1]?.trim();
    if (!include) continue;
    const relative = normalizeRelativePath(path.posix.join(path.posix.dirname(relativePath), include));
    const dependency = files.has(relative)
      ? relative
      : files.has(include)
        ? include
        : uniqueSuffixFile(files, [`/${include}`]);
    if (dependency && dependency !== relativePath) resolved.add(dependency);
  }
  return [...resolved].sort().map((candidate) => fileModuleId(candidate, files));
}

function uniqueSuffixFile(files: Set<string>, suffixes: string[]): string | undefined {
  const matches = [...files].filter((candidate) => suffixes.some((suffix) => `/${candidate}`.endsWith(suffix)));
  return matches.length === 1 ? matches[0] : undefined;
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
    const gitRoot = await ownGitRepositoryRoot(root);
    if (!gitRoot) return {};
    const [head, status] = await Promise.all([
      git(gitRoot, ["rev-parse", "--verify", "HEAD"]),
      git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
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
    const gitRoot = await ownGitRepositoryRoot(root);
    if (!gitRoot) return [];
    const status = await git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
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

async function ownGitRepositoryRoot(root: string): Promise<string | undefined> {
  try {
    const topLevel = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (!topLevel) return undefined;
    const [rootReal, topReal] = await Promise.all([realpath(root), realpath(topLevel)]);
    return rootReal === topReal ? topReal : undefined;
  } catch {
    return undefined;
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
    `Observed structure is generated in \`.devspace/architecture/model.json\`. Versioned design intent lives in \`${ARCHITECTURE_INTENT_FILE}\`; change it only through an explicit architecture change.`,
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
  for (const rule of model.policies.dependencyRules) {
    lines.push(`- ${rule.kind === "forbid_dependency" ? "forbid" : "require"}: \`${rule.from}\` -> \`${rule.to}\``);
  }
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
  const contracts = module.contracts.length > 0 ? ` [contracts: ${module.contracts.map(formatContract).join("; ")}]` : "";
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
<script>const model=${payload};const list=document.getElementById('list'),q=document.getElementById('q');function e(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function c(x){return x.kind==='note'?x.text:x.kind+' '+x.to}function draw(){const x=q.value.toLowerCase();list.innerHTML=model.modules.filter(m=>JSON.stringify(m).toLowerCase().includes(x)).map(m=>'<div class="m"><div class="p"><b>'+e(m.path)+'</b> <span class="muted">'+e(m.kind)+'</span></div>'+(m.summary?'<div>'+e(m.summary)+'</div>':'')+(m.contracts.length?'<div><b>contracts</b>: '+m.contracts.map(c).map(e).join('; ')+'</div>':'')+(m.dependencies.length?'<div class="muted">depends on '+m.dependencies.map(e).join(', ')+'</div>':'')+(m.tags.length?'<div>'+m.tags.map(t=>'<span class="tag">'+e(t)+'</span>').join('')+'</div>':'')+'</div>').join('')}q.addEventListener('input',draw);draw();</script></body></html>\n`;
}

function formatContract(contract: ArchitectureContract): string {
  return contract.kind === "note" ? contract.text : `${contract.kind} ${contract.to}`;
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

function compactLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 3))}...` : oneLine;
}

function uniqueContracts(values: ArchitectureContract[]): ArchitectureContract[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
