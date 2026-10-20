import * as z from "zod/v4";
import {
  ArchitectureModelManager,
  type ArchitectureContract,
  type ArchitectureIssue,
} from "./architecture-model.js";
import { LearningStore, type LearningCandidate, type LearningEpisode } from "./learning-store.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import {
  type ToolRegistrationContext,
} from "./tool-surfaces/types.js";

const PROJECT_ACTIONS = [
  "help",
  "arch_init", "arch_brief", "arch_affected", "arch_validate", "arch_refresh",
  "arch_annotate", "arch_policy", "arch_change_open", "arch_change_close", "arch_render",
  "learn_recall", "learn_distill", "learn_candidates", "learn_promote", "learn_reject", "learn_stats",
] as const;
type ProjectAction = typeof PROJECT_ACTIONS[number];

const architectureContractSchema = z.union([
  z.object({ kind: z.literal("forbid_dependency"), to: z.string() }),
  z.object({ kind: z.literal("require_dependency"), to: z.string() }),
  z.object({ kind: z.literal("note"), text: z.string() }),
]);

const dependencyRuleSchema = z.object({
  kind: z.enum(["forbid_dependency", "require_dependency"]),
  from: z.string(),
  to: z.string(),
});

const PROJECT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
};

export function registerProjectIntelligenceTools(
  context: ToolRegistrationContext,
  learning = new LearningStore(context.config.stateDir),
): void {
  const { server, config, workspaces, semantic } = context;
  const manager = new ArchitectureModelManager({ semantic });
  server.registerTool(
    "project",
    {
      title: "Project",
      description: "Architecture governance and validated workflow learning.",
      inputSchema: {
        workspaceId: z.string(),
        action: z.string().min(1).max(80).describe("Project action. Use action=help to discover supported operations."),
        target: z.string().optional(),
        paths: z.array(z.string()).optional(),
        intent: z.string().optional(),
        changeId: z.string().optional(),
        rationale: z.string().optional(),
        architectureChange: z.boolean().optional(),
        summary: z.string().optional(),
        contracts: z.array(architectureContractSchema).optional(),
        tags: z.array(z.string()).optional(),
        acyclic: z.boolean().optional(),
        maxDepth: z.number().int().positive().optional(),
        dependencyRules: z.array(dependencyRuleSchema).optional(),
        semanticEvidence: z.boolean().optional(),
        detail: z.boolean().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: PROJECT_WRITE_ANNOTATIONS,
    },
    async (input, extra) => {
      const startedAt = performance.now();
      const { workspaceId, action, args } = input;
      const projectAction = parseProjectAction(action);
      const workspace = await workspaces.getWorkspace(workspaceId);
      const values = mergeActionValues(actionArgs(args), input);
      const target = optionalString(values, "target", 2_000);
      const paths = optionalStringArray(values, "paths", 100, 2_000);
      const intent = optionalString(values, "intent", 2_000);
      const changeId = optionalString(values, "changeId", 200);
      const rationale = optionalString(values, "rationale", 2_000);
      const architectureChange = optionalBoolean(values, "architectureChange");
      const summary = optionalString(values, "summary", 2_000);
      const contracts = optionalArchitectureContracts(values, "contracts");
      const tags = optionalStringArray(values, "tags", 50, 120);
      const acyclic = optionalBooleanValue(values, "acyclic");
      const maxDepth = optionalPositiveInteger(values, "maxDepth");
      const dependencyRules = optionalDependencyRules(values, "dependencyRules");
      const semanticEvidence = optionalBooleanValue(values, "semanticEvidence") ?? false;
      const query = optionalString(values, "query", 2_000);
      const title = optionalString(values, "title", 200);
      const trigger = optionalString(values, "trigger", 1_000);
      const procedure = optionalStringArray(values, "procedure", 50, 2_000);
      const evidenceEpisodeIds = optionalStringArray(values, "evidenceEpisodeIds", 50, 200);
      const candidateId = optionalString(values, "candidateId", 200);
      const validationNote = optionalString(values, "validationNote", 2_000);
      const status = optionalCandidateStatus(values, "status");
      const detail = optionalBoolean(values, "detail");
      let result: string;
      let details: Record<string, unknown> = { action };

      if (projectAction === "help") {
        result = [
          "Architecture: arch_init, arch_brief(target), arch_affected(paths), arch_validate(semanticEvidence?), arch_refresh, arch_change_open(intent, paths, architectureChange?, rationale?), arch_annotate(changeId + target + summary/contracts/tags), arch_policy(changeId + acyclic/maxDepth/dependencyRules), arch_change_close(changeId), arch_render.",
          "Architecture intent is versioned in .devspace-architecture.json and protected: annotations and policies may change only inside an explicit architecture change with rationale. note contracts document intent; forbid_dependency/require_dependency contracts are executable.",
          "Learning: learn_recall(query), learn_distill(title, trigger, procedure, evidenceEpisodeIds?), learn_candidates(status?), learn_promote(candidateId, validationNote), learn_reject(candidateId, validationNote?), learn_stats.",
          "Set detail=true to expand supported read results. Legacy args remains accepted for older hosts.",
        ].join("\n");
      } else if (projectAction === "arch_init") {
        const model = await manager.initialize(workspace.root);
        const rendered = await manager.render(workspace.root, model);
        result = `Architecture initialized: ${model.modules.length} modules. intent=.devspace-architecture.json; observed=.devspace/architecture/model.json; markdown=${rendered.markdownPath}; html=${rendered.htmlPath}`;
        details = { ...details, moduleCount: model.modules.length, ...rendered };
      } else if (projectAction === "arch_refresh") {
        const model = await manager.refresh(workspace.root);
        const rendered = await manager.render(workspace.root, model);
        result = `Architecture refreshed: ${model.modules.length} modules at ${shortRevision(model.revision.head)}.`;
        details = { ...details, moduleCount: model.modules.length, revision: model.revision, ...rendered };
      } else if (projectAction === "arch_validate") {
        const issues = await manager.conformance(workspace.root, { semantic: semanticEvidence });
        const errors = issues.filter((item) => item.severity === "error").length;
        const warnings = issues.filter((item) => item.severity === "warning").length;
        result = formatIssues(issues);
        details = { ...details, errors, warnings, ...(detail ? { detail: { issues } } : {}) };
      } else if (projectAction === "arch_brief") {
        if (!target) throw new Error("project arch_brief requires target.");
        const brief = await manager.brief(workspace.root, target);
        result = formatBrief(brief.module, brief.dependents, brief.issues);
        details = {
          ...details,
          moduleId: brief.module.id,
          path: brief.module.path,
          dependentIds: brief.dependents.map((item) => item.id),
          issueCount: brief.issues.length,
          ...(detail ? { detail: brief } : {}),
        };
      } else if (projectAction === "arch_affected") {
        const affected = await manager.affected(workspace.root, paths);
        result = formatAffected(affected.changedPaths, affected.modules.map((module) => module.id));
        details = {
          ...details,
          changedPaths: affected.changedPaths,
          moduleIds: affected.modules.map((module) => module.id),
          ...(detail ? { detail: affected } : {}),
        };
      } else if (projectAction === "arch_annotate") {
        if (!target) throw new Error("project arch_annotate requires target.");
        if (!changeId) throw new Error("project arch_annotate requires changeId from an open architecture change.");
        if (summary === undefined && contracts === undefined && tags === undefined) {
          throw new Error("project arch_annotate requires summary, contracts, or tags.");
        }
        const module = await manager.annotate(workspace.root, target, { summary, contracts, tags }, changeId);
        await manager.render(workspace.root);
        result = `Architecture annotation updated for ${module.id}.`;
        details = { ...details, moduleId: module.id, path: module.path, ...(detail ? { detail: { module } } : {}) };
      } else if (projectAction === "arch_policy") {
        if (!changeId) throw new Error("project arch_policy requires changeId from an open architecture change.");
        if (acyclic === undefined && maxDepth === undefined && dependencyRules === undefined) {
          throw new Error("project arch_policy requires acyclic, maxDepth, or dependencyRules.");
        }
        const policies = await manager.updatePolicy(workspace.root, changeId, {
          ...(acyclic !== undefined ? { acyclic } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(dependencyRules !== undefined ? { dependencyRules } : {}),
        });
        await manager.render(workspace.root);
        result = `Architecture policy updated inside ${changeId}.`;
        details = { ...details, changeId, ...(detail ? { detail: { policies } } : {}) };
      } else if (projectAction === "arch_change_open") {
        if (!intent?.trim()) throw new Error("project arch_change_open requires intent.");
        const change = await manager.openChange(workspace.root, intent, paths ?? [], { architectureChange, rationale });
        result = `${change.kind === "architecture" ? "Architecture" : "Implementation"} change ${change.id} opened; ${change.affectedModules.length} affected module(s).`;
        details = {
          ...details,
          changeId: change.id,
          affectedModules: change.affectedModules,
          ...(detail ? { detail: { change } } : {}),
        };
      } else if (projectAction === "arch_change_close") {
        if (!changeId) throw new Error("project arch_change_close requires changeId.");
        const closed = await manager.closeChange(workspace.root, changeId);
        const errors = closed.issues.filter((item) => item.severity === "error").length;
        const warnings = closed.issues.filter((item) => item.severity === "warning").length;
        result = `Architecture change ${closed.change.id} verified and frozen. ${formatIssueCounts(closed.issues)}`;
        details = {
          ...details,
          changeId: closed.change.id,
          errors,
          warnings,
          ...(detail ? { detail: closed } : {}),
        };
      } else if (projectAction === "arch_render") {
        const rendered = await manager.render(workspace.root);
        result = `Architecture rendered: ${rendered.markdownPath}; ${rendered.htmlPath}`;
        details = { ...details, ...rendered };
      } else if (projectAction === "learn_recall") {
        const recalled = learning.recall(workspace.root, query ?? "", 8);
        result = formatRecall(recalled.episodes, recalled.candidates);
        details = {
          ...details,
          episodeIds: recalled.episodes.map((item) => item.id),
          candidateIds: recalled.candidates.map((item) => item.id),
          ...(detail ? { detail: recalled } : {}),
        };
      } else if (projectAction === "learn_distill") {
        if (!title || !trigger || !procedure?.length) {
          throw new Error("project learn_distill requires title, trigger, and procedure.");
        }
        const candidate = learning.distill({
          workspaceRoot: workspace.root,
          title,
          trigger,
          procedure,
          evidenceEpisodeIds,
        });
        result = `Candidate ${candidate.id} distilled from ${candidate.evidenceEpisodeIds.length} supporting episode(s). Evidence count is not a reliability probability; validate before promotion.`;
        details = {
          ...details,
          candidateId: candidate.id,
          evidenceCount: candidate.evidenceEpisodeIds.length,
          ...(detail ? { detail: { candidate } } : {}),
        };
      } else if (projectAction === "learn_candidates") {
        const candidates = learning.listCandidates(workspace.root, status);
        result = formatCandidates(candidates);
        details = {
          ...details,
          candidateIds: candidates.map((item) => item.id),
          candidateCount: candidates.length,
          ...(detail ? { detail: { candidates } } : {}),
        };
      } else if (projectAction === "learn_promote") {
        if (!candidateId || !validationNote?.trim()) {
          throw new Error("project learn_promote requires candidateId and validationNote.");
        }
        const candidate = await learning.promote(workspace.root, candidateId, validationNote);
        result = `Candidate ${candidate.id} promoted to ${candidate.skillPath}. Reopen the workspace to load the new project skill.`;
        details = {
          ...details,
          candidateId: candidate.id,
          skillPath: candidate.skillPath,
          ...(detail ? { detail: { candidate } } : {}),
        };
      } else if (projectAction === "learn_reject") {
        if (!candidateId) throw new Error("project learn_reject requires candidateId.");
        const candidate = learning.reject(workspace.root, candidateId, validationNote);
        result = `Candidate ${candidate.id} rejected.`;
        details = { ...details, candidateId: candidate.id, status: candidate.status, ...(detail ? { detail: { candidate } } : {}) };
      } else {
        const stats = learning.stats(workspace.root);
        result = `Learning: ${stats.episodes} episodes (${stats.successful} successful), ${stats.candidates} candidates, ${stats.promoted} promoted.`;
        details = { ...details, stats };
      }

      const conversationScopeId = conversationScopeIdFromRequestMeta(extra._meta);
      logToolCall(config, {
        tool: "project",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        ...(conversationScopeId ? { path: `conversation:${conversationScopeId.slice(0, 12)}` } : {}),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, ...details },
      };
    },
  );
}

function formatBrief(
  module: { id: string; path: string; kind: string; summary?: string; contracts: ArchitectureContract[]; dependencies: string[] },
  dependents: Array<{ id: string }>,
  issues: ArchitectureIssue[],
): string {
  return [
    `${module.id} (${module.kind}) path=${module.path}`,
    module.summary ? `summary: ${module.summary}` : undefined,
    module.contracts.length ? `contracts: ${module.contracts.map(formatArchitectureContract).join(" | ")}` : "contracts: none",
    `depends: ${boundedList(module.dependencies)}`,
    `dependents: ${boundedList(dependents.map((item) => item.id))}`,
    issues.length ? `issues: ${issues.map((item) => `${item.severity}:${item.code}`).join(", ")}` : "issues: none",
  ].filter(Boolean).join("\n");
}

function formatIssues(issues: ArchitectureIssue[]): string {
  if (issues.length === 0) return "Architecture valid: 0 errors, 0 warnings.";
  const lines = [`Architecture validation: ${formatIssueCounts(issues)}`];
  for (const item of issues.slice(0, 12)) lines.push(`- ${item.severity} ${item.code}: ${item.message}`);
  if (issues.length > 12) lines.push(`... ${issues.length - 12} more issue(s)`);
  return lines.join("\n");
}

function formatIssueCounts(issues: ArchitectureIssue[]): string {
  return `${issues.filter((item) => item.severity === "error").length} error(s), ${issues.filter((item) => item.severity === "warning").length} warning(s)`;
}

function formatAffected(changedPaths: string[], moduleIds: string[]): string {
  return `Changed paths: ${boundedList(changedPaths)}\nAffected modules: ${boundedList(moduleIds, 40)}`;
}

function formatRecall(episodes: LearningEpisode[], candidates: LearningCandidate[]): string {
  const lines = [`Recall: ${episodes.length} episode(s), ${candidates.length} candidate(s).`];
  for (const candidate of candidates.slice(0, 5)) {
    lines.push(`- candidate ${candidate.id} [${candidate.status}, evidence=${candidate.evidenceEpisodeIds.length}] ${candidate.title}: ${candidate.trigger}`);
  }
  for (const episode of episodes.slice(0, 8)) {
    lines.push(`- ${episode.id} ${episode.success ? "ok" : "fail"} ${episode.tool}: ${compactLine(episode.inputSummary, 180)} => ${compactLine(episode.outputSummary, 220)}`);
  }
  return lines.join("\n");
}

function formatCandidates(candidates: LearningCandidate[]): string {
  if (candidates.length === 0) return "No learning candidates.";
  return candidates.slice(0, 30).map((candidate) => (
    `${candidate.id} [${candidate.status}, evidence=${candidate.evidenceEpisodeIds.length}] ${candidate.title} — ${candidate.trigger}${candidate.skillPath ? ` -> ${candidate.skillPath}` : ""}`
  )).join("\n");
}

function formatArchitectureContract(contract: ArchitectureContract): string {
  return contract.kind === "note" ? `note:${contract.text}` : `${contract.kind}:${contract.to}`;
}

function boundedList(values: string[], max = 20): string {
  if (values.length === 0) return "none";
  const visible = values.slice(0, max).join(", ");
  return values.length > max ? `${visible}, ... +${values.length - max}` : visible;
}

function compactLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function shortRevision(value: string | undefined): string {
  return value ? value.slice(0, 12) : "working tree";
}

function actionArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project args must be an object.");
  }
  return value as Record<string, unknown>;
}

function mergeActionValues(
  legacy: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const values = { ...legacy };
  for (const [key, value] of Object.entries(input)) {
    if (key === "workspaceId" || key === "action" || key === "args" || value === undefined) continue;
    values[key] = value;
  }
  return values;
}

function parseProjectAction(value: string): ProjectAction {
  if ((PROJECT_ACTIONS as readonly string[]).includes(value)) return value as ProjectAction;
  throw new Error(`Unknown project action: ${value}. Supported: ${PROJECT_ACTIONS.join(", ")}`);
}

function optionalString(
  values: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`project args.${key} must be a string.`);
  if (value.length > maxLength) throw new Error(`project args.${key} exceeds ${maxLength} characters.`);
  return value;
}

function optionalStringArray(
  values: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`project args.${key} must be an array of strings.`);
  }
  if (value.length > maxItems) throw new Error(`project args.${key} exceeds ${maxItems} items.`);
  if (value.some((item) => item.length > maxLength)) {
    throw new Error(`project args.${key} contains a value longer than ${maxLength} characters.`);
  }
  return value as string[];
}

function optionalCandidateStatus(
  values: Record<string, unknown>,
  key: string,
): LearningCandidate["status"] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (value !== "candidate" && value !== "promoted" && value !== "rejected") {
    throw new Error(`project args.${key} must be candidate, promoted, or rejected.`);
  }
  return value;
}

function optionalBoolean(values: Record<string, unknown>, key: string): boolean {
  const value = values[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`project args.${key} must be a boolean.`);
  return value;
}

function optionalBooleanValue(values: Record<string, unknown>, key: string): boolean | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`project args.${key} must be a boolean.`);
  return value;
}

function optionalPositiveInteger(values: Record<string, unknown>, key: string): number | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`project args.${key} must be a positive integer.`);
  }
  return value;
}

function optionalArchitectureContracts(
  values: Record<string, unknown>,
  key: string,
): ArchitectureContract[] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`project ${key} must be an array with at most 50 contracts.`);
  }
  const contracts: ArchitectureContract[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim()) contracts.push({ kind: "note", text: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`project ${key} entries must be contract objects.`);
    }
    const contract = item as { kind?: unknown; to?: unknown; text?: unknown };
    if (contract.kind === "note") {
      if (typeof contract.text !== "string" || !contract.text.trim()) throw new Error("project note contracts require text.");
      contracts.push({ kind: "note", text: contract.text.trim() });
      continue;
    }
    if (contract.kind === "forbid_dependency" || contract.kind === "require_dependency") {
      if (typeof contract.to !== "string" || !contract.to.trim()) throw new Error(`project ${contract.kind} contracts require to.`);
      contracts.push({ kind: contract.kind, to: contract.to.trim() });
      continue;
    }
    throw new Error(`Unknown project architecture contract kind: ${String(contract.kind)}.`);
  }
  return contracts;
}

function optionalDependencyRules(
  values: Record<string, unknown>,
  key: string,
): Array<{ kind: "forbid_dependency" | "require_dependency"; from: string; to: string }> | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`project ${key} must be an array with at most 100 rules.`);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`project ${key} entries must be rule objects.`);
    const rule = item as { kind?: unknown; from?: unknown; to?: unknown };
    if (rule.kind !== "forbid_dependency" && rule.kind !== "require_dependency") {
      throw new Error(`project ${key} rule kind must be forbid_dependency or require_dependency.`);
    }
    if (typeof rule.from !== "string" || !rule.from.trim() || typeof rule.to !== "string" || !rule.to.trim()) {
      throw new Error(`project ${key} rules require non-empty from/to strings.`);
    }
    return { kind: rule.kind, from: rule.from.trim(), to: rule.to.trim() };
  });
}
