import { createHash } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const ARCHITECTURE_INTENT_FILE = ".devspace-architecture.json";
export const ARCHITECTURE_INTENT_VERSION = 1 as const;

export type ArchitectureContract =
  | { kind: "forbid_dependency"; to: string }
  | { kind: "require_dependency"; to: string }
  | { kind: "note"; text: string };

export interface ArchitectureIntentAnnotation {
  target: string;
  summary?: string;
  contracts: ArchitectureContract[];
  tags: string[];
}

export interface ArchitectureDependencyRule {
  kind: "forbid_dependency" | "require_dependency";
  from: string;
  to: string;
}

export interface ArchitecturePolicy {
  acyclic: boolean;
  maxDepth: number;
  dependencyRules: ArchitectureDependencyRule[];
}

export interface ArchitectureIntent {
  version: typeof ARCHITECTURE_INTENT_VERSION;
  project: string;
  policies: ArchitecturePolicy;
  annotations: ArchitectureIntentAnnotation[];
}

export function defaultArchitectureIntent(project: string): ArchitectureIntent {
  return {
    version: ARCHITECTURE_INTENT_VERSION,
    project,
    policies: {
      acyclic: false,
      maxDepth: 12,
      dependencyRules: [],
    },
    annotations: [],
  };
}

export async function hasArchitectureIntent(root: string): Promise<boolean> {
  try {
    await access(path.join(root, ARCHITECTURE_INTENT_FILE));
    return true;
  } catch {
    return false;
  }
}

export async function loadArchitectureIntent(root: string): Promise<ArchitectureIntent | undefined> {
  const file = path.join(root, ARCHITECTURE_INTENT_FILE);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return normalizeArchitectureIntent(parsed, path.basename(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveArchitectureIntent(root: string, intent: ArchitectureIntent): Promise<void> {
  const file = path.join(root, ARCHITECTURE_INTENT_FILE);
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(normalizeArchitectureIntent(intent, path.basename(root)), null, 2)}\n`);
  await rename(temporary, file);
}

export function architectureIntentFingerprint(intent: ArchitectureIntent): string {
  return createHash("sha256").update(JSON.stringify(normalizeArchitectureIntent(intent, intent.project))).digest("hex");
}

export function normalizeArchitectureIntent(value: unknown, project: string): ArchitectureIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${ARCHITECTURE_INTENT_FILE}: expected an object.`);
  }
  const input = value as Record<string, unknown>;
  if (input.version !== ARCHITECTURE_INTENT_VERSION) {
    throw new Error(`Unsupported ${ARCHITECTURE_INTENT_FILE} version: ${String(input.version)}.`);
  }
  const policies = normalizePolicies(input.policies);
  const annotations = Array.isArray(input.annotations)
    ? input.annotations.map(normalizeAnnotation)
    : [];
  return {
    version: ARCHITECTURE_INTENT_VERSION,
    project: typeof input.project === "string" && input.project.trim() ? input.project.trim() : project,
    policies,
    annotations: dedupeAnnotations(annotations),
  };
}

function normalizePolicies(value: unknown): ArchitecturePolicy {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const acyclic = typeof input.acyclic === "boolean" ? input.acyclic : false;
  const maxDepth = Number.isInteger(input.maxDepth) && Number(input.maxDepth) > 0
    ? Number(input.maxDepth)
    : 12;
  const dependencyRules = Array.isArray(input.dependencyRules)
    ? input.dependencyRules.map(normalizeDependencyRule)
    : [];
  return { acyclic, maxDepth, dependencyRules: dedupeRules(dependencyRules) };
}

function normalizeAnnotation(value: unknown): ArchitectureIntentAnnotation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${ARCHITECTURE_INTENT_FILE} annotation.`);
  }
  const input = value as Record<string, unknown>;
  const target = typeof input.target === "string" ? normalizeTarget(input.target) : "";
  if (!target) throw new Error(`Invalid ${ARCHITECTURE_INTENT_FILE} annotation target.`);
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : undefined;
  const contracts = Array.isArray(input.contracts)
    ? input.contracts.map(normalizeContract)
    : [];
  const tags = Array.isArray(input.tags)
    ? uniqueStrings(input.tags.filter((item): item is string => typeof item === "string"))
    : [];
  return { target, summary, contracts: dedupeContracts(contracts), tags };
}

function normalizeContract(value: unknown): ArchitectureContract {
  if (typeof value === "string") {
    return { kind: "note", text: value.trim() };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${ARCHITECTURE_INTENT_FILE} contract.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind === "note") {
    if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Architecture note contract requires text.");
    return { kind: "note", text: input.text.trim() };
  }
  if (input.kind === "forbid_dependency" || input.kind === "require_dependency") {
    if (typeof input.to !== "string" || !input.to.trim()) throw new Error(`Architecture ${input.kind} contract requires to.`);
    return { kind: input.kind, to: input.to.trim() };
  }
  throw new Error(`Unknown architecture contract kind: ${String(input.kind)}.`);
}

function normalizeDependencyRule(value: unknown): ArchitectureDependencyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${ARCHITECTURE_INTENT_FILE} dependency rule.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "forbid_dependency" && input.kind !== "require_dependency") {
    throw new Error(`Unknown architecture dependency rule kind: ${String(input.kind)}.`);
  }
  if (typeof input.from !== "string" || !input.from.trim() || typeof input.to !== "string" || !input.to.trim()) {
    throw new Error("Architecture dependency rules require non-empty from/to patterns.");
  }
  return { kind: input.kind, from: input.from.trim(), to: input.to.trim() };
}

function dedupeAnnotations(values: ArchitectureIntentAnnotation[]): ArchitectureIntentAnnotation[] {
  const byTarget = new Map<string, ArchitectureIntentAnnotation>();
  for (const value of values) byTarget.set(value.target, value);
  return [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
}

function dedupeContracts(values: ArchitectureContract[]): ArchitectureContract[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRules(values: ArchitectureDependencyRule[]): ArchitectureDependencyRule[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}\0${value.from}\0${value.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
