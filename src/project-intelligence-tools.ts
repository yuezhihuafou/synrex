import * as z from "zod/v4";
import { ArchitectureModelManager, type ArchitectureIssue } from "./architecture-model.js";
import { LearningStore, type LearningCandidate, type LearningEpisode } from "./learning-store.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import {
  type ToolRegistrationContext,
} from "./tool-surfaces/types.js";

const PROJECT_ACTIONS = [
  "help",
  "arch_init", "arch_brief", "arch_affected", "arch_validate", "arch_refresh",
  "arch_annotate", "arch_change_open", "arch_change_close", "arch_render",
  "learn_recall", "learn_distill", "learn_candidates", "learn_promote", "learn_reject", "learn_stats",
] as const;
type ProjectAction = typeof PROJECT_ACTIONS[number];

const PROJECT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
};

export function registerProjectIntelligenceTools(
  context: ToolRegistrationContext,
  learning = new LearningStore(context.config.stateDir),
): void {
  const { server, config, workspaces } = context;
  const manager = new ArchitectureModelManager();
  server.registerTool(
    "project",
    {
      title: "Project",
      description: "Project model and learning.",
      inputSchema: {
        workspaceId: z.string(),
        action: z.string().describe("Use help to list actions."),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: PROJECT_WRITE_ANNOTATIONS,
    },
    async ({ workspaceId, action, args }, extra) => {
      const startedAt = performance.now();
      const projectAction = parseProjectAction(action);
      const workspace = await workspaces.getWorkspace(workspaceId);
      const values = actionArgs(args);
      const target = optionalString(values, "target", 2_000);
      const paths = optionalStringArray(values, "paths", 100, 2_000);
      const intent = optionalString(values, "intent", 2_000);
      const changeId = optionalString(values, "changeId", 200);
      const summary = optionalString(values, "summary", 2_000);
      const contracts = optionalStringArray(values, "contracts", 50, 1_000);
      const tags = optionalStringArray(values, "tags", 50, 120);
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
          "Architecture: arch_init, arch_brief(target), arch_affected(paths), arch_validate, arch_refresh, arch_annotate(target + summary/contracts/tags), arch_change_open(intent, paths), arch_change_close(changeId), arch_render.",
          "Learning: learn_recall(query), learn_distill(title, trigger, procedure, evidenceEpisodeIds?), learn_candidates(status?), learn_promote(candidateId, validationNote), learn_reject(candidateId, validationNote?), learn_stats.",
          "Set args.detail=true to expand supported read results.",
        ].join("\n");
      } else if (projectAction === "arch_init") {
        const model = await manager.initialize(workspace.root);
        const rendered = await manager.render(workspace.root, model);
        result = `Architecture initialized: ${model.modules.length} modules. model=.devspace/architecture/model.json; markdown=${rendered.markdownPath}; html=${rendered.htmlPath}`;
        details = { ...details, moduleCount: model.modules.length, ...rendered };
      } else if (projectAction === "arch_refresh") {
        const model = await manager.refresh(workspace.root);
        const rendered = await manager.render(workspace.root, model);
        result = `Architecture refreshed: ${model.modules.length} modules at ${shortRevision(model.revision.head)}.`;
        details = { ...details, moduleCount: model.modules.length, revision: model.revision, ...rendered };
      } else if (projectAction === "arch_validate") {
        const issues = await manager.validate(workspace.root);
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
        if (summary === undefined && contracts === undefined && tags === undefined) {
          throw new Error("project arch_annotate requires summary, contracts, or tags.");
        }
        const module = await manager.annotate(workspace.root, target, { summary, contracts, tags });
        await manager.render(workspace.root);
        result = `Architecture annotation updated for ${module.id}.`;
        details = { ...details, moduleId: module.id, path: module.path, ...(detail ? { detail: { module } } : {}) };
      } else if (projectAction === "arch_change_open") {
        if (!intent?.trim()) throw new Error("project arch_change_open requires intent.");
        const change = await manager.openChange(workspace.root, intent, paths ?? []);
        result = `Architecture change ${change.id} opened; ${change.affectedModules.length} affected module(s).`;
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
        result = `Candidate ${candidate.id} distilled from ${candidate.evidenceEpisodeIds.length} episode(s), confidence=${candidate.confidence.toFixed(2)}. Validate before promotion.`;
        details = {
          ...details,
          candidateId: candidate.id,
          confidence: candidate.confidence,
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
  module: { id: string; path: string; kind: string; summary?: string; contracts: string[]; dependencies: string[] },
  dependents: Array<{ id: string }>,
  issues: ArchitectureIssue[],
): string {
  return [
    `${module.id} (${module.kind}) path=${module.path}`,
    module.summary ? `summary: ${module.summary}` : undefined,
    module.contracts.length ? `contracts: ${module.contracts.join(" | ")}` : "contracts: none",
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
    lines.push(`- candidate ${candidate.id} [${candidate.status}, ${candidate.confidence.toFixed(2)}] ${candidate.title}: ${candidate.trigger}`);
  }
  for (const episode of episodes.slice(0, 8)) {
    lines.push(`- ${episode.id} ${episode.success ? "ok" : "fail"} ${episode.tool}: ${compactLine(episode.inputSummary, 180)} => ${compactLine(episode.outputSummary, 220)}`);
  }
  return lines.join("\n");
}

function formatCandidates(candidates: LearningCandidate[]): string {
  if (candidates.length === 0) return "No learning candidates.";
  return candidates.slice(0, 30).map((candidate) => (
    `${candidate.id} [${candidate.status}, ${candidate.confidence.toFixed(2)}] ${candidate.title} — ${candidate.trigger}${candidate.skillPath ? ` -> ${candidate.skillPath}` : ""}`
  )).join("\n");
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
