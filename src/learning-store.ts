import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "./db/client.js";

const MAX_EPISODES_PER_WORKSPACE = 2_000;
const MAX_INPUT_CHARS = 1_200;
const MAX_OUTPUT_CHARS = 2_000;

export interface LearningEpisode {
  id: string;
  workspaceRoot: string;
  conversationScopeId?: string;
  tool: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  createdAt: string;
}

export type LearningCandidateStatus = "candidate" | "promoted" | "rejected";

export interface LearningCandidate {
  id: string;
  workspaceRoot: string;
  title: string;
  trigger: string;
  procedure: string[];
  evidenceEpisodeIds: string[];
  confidence: number;
  status: LearningCandidateStatus;
  validationNote?: string;
  skillPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningRecallResult {
  episodes: LearningEpisode[];
  candidates: LearningCandidate[];
}

export class LearningStore {
  constructor(private readonly stateDir: string) {}

  recordToolCall(input: {
    workspaceRoot: string;
    conversationScopeId?: string;
    tool: string;
    toolInput: unknown;
    toolOutput?: unknown;
    error?: unknown;
  }): void {
    if (input.tool === "learning") return;
    const database = openDatabase(this.stateDir);
    try {
      const episode: LearningEpisode = {
        id: `ep_${randomUUID()}`,
        workspaceRoot: input.workspaceRoot,
        conversationScopeId: input.conversationScopeId,
        tool: input.tool,
        inputSummary: summarizeInput(input.tool, input.toolInput),
        outputSummary: input.error
          ? truncate(redactSecrets(errorMessage(input.error)), MAX_OUTPUT_CHARS)
          : summarizeOutput(input.toolOutput),
        success: input.error === undefined && !responseIsError(input.toolOutput),
        createdAt: new Date().toISOString(),
      };
      database.sqlite.prepare(`
        insert into learning_episodes (
          id, workspace_root, conversation_scope_id, tool, input_summary,
          output_summary, success, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        episode.id,
        episode.workspaceRoot,
        episode.conversationScopeId ?? null,
        episode.tool,
        episode.inputSummary,
        episode.outputSummary,
        episode.success ? 1 : 0,
        episode.createdAt,
      );
      database.sqlite.prepare(`
        delete from learning_episodes
        where workspace_root = ? and id not in (
          select id from learning_episodes
          where workspace_root = ?
          order by created_at desc
          limit ?
        )
      `).run(input.workspaceRoot, input.workspaceRoot, MAX_EPISODES_PER_WORKSPACE);
    } finally {
      database.close();
    }
  }

  recall(workspaceRoot: string, query: string, limit = 8): LearningRecallResult {
    const database = openDatabase(this.stateDir);
    try {
      const tokens = queryTokens(query);
      const episodeRows = database.sqlite.prepare(`
        select * from learning_episodes
        where workspace_root = ?
        order by created_at desc
        limit 300
      `).all(workspaceRoot) as LearningEpisodeRow[];
      const candidateRows = database.sqlite.prepare(`
        select * from learning_candidates
        where workspace_root = ? and status != 'rejected'
        order by updated_at desc
        limit 100
      `).all(workspaceRoot) as LearningCandidateRow[];

      const episodes = episodeRows
        .map(rowToEpisode)
        .map((episode) => ({ episode, score: textScore(tokens, `${episode.tool} ${episode.inputSummary} ${episode.outputSummary}`) + (episode.success ? 0.2 : 0) }))
        .filter((item) => tokens.length === 0 || item.score > 0)
        .sort((a, b) => b.score - a.score || b.episode.createdAt.localeCompare(a.episode.createdAt))
        .slice(0, Math.max(1, Math.min(limit, 20)))
        .map((item) => item.episode);
      const candidates = candidateRows
        .map(rowToCandidate)
        .map((candidate) => ({ candidate, score: textScore(tokens, `${candidate.title} ${candidate.trigger} ${candidate.procedure.join(" ")}`) + candidate.confidence }))
        .filter((item) => tokens.length === 0 || item.score > 0)
        .sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 20)))
        .map((item) => item.candidate);
      return { episodes, candidates };
    } finally {
      database.close();
    }
  }

  recentSuccessfulEpisodes(workspaceRoot: string, limit = 12): LearningEpisode[] {
    const database = openDatabase(this.stateDir);
    try {
      const rows = database.sqlite.prepare(`
        select * from learning_episodes
        where workspace_root = ? and success = 1
        order by created_at desc
        limit ?
      `).all(workspaceRoot, Math.max(1, Math.min(limit, 50))) as LearningEpisodeRow[];
      return rows.map(rowToEpisode);
    } finally {
      database.close();
    }
  }

  distill(input: {
    workspaceRoot: string;
    title: string;
    trigger: string;
    procedure: string[];
    evidenceEpisodeIds?: string[];
  }): LearningCandidate {
    const title = input.title.trim();
    const trigger = input.trigger.trim();
    const procedure = uniqueStrings(input.procedure);
    if (!title || !trigger || procedure.length === 0) {
      throw new Error("Distillation requires title, trigger, and at least one procedure step.");
    }
    const evidence = input.evidenceEpisodeIds?.length
      ? uniqueStrings(input.evidenceEpisodeIds)
      : this.recentSuccessfulEpisodes(input.workspaceRoot, 8).map((episode) => episode.id);
    if (evidence.length === 0) throw new Error("No successful evidence episodes are available for this candidate.");

    const database = openDatabase(this.stateDir);
    try {
      const placeholders = evidence.map(() => "?").join(",");
      const found = database.sqlite.prepare(`
        select id from learning_episodes
        where workspace_root = ? and id in (${placeholders})
      `).all(input.workspaceRoot, ...evidence) as Array<{ id: string }>;
      if (found.length !== evidence.length) {
        throw new Error("One or more evidence episodes do not belong to this workspace or no longer exist.");
      }
      const now = new Date().toISOString();
      const candidate: LearningCandidate = {
        id: `skillcand_${randomUUID()}`,
        workspaceRoot: input.workspaceRoot,
        title,
        trigger,
        procedure,
        evidenceEpisodeIds: evidence,
        confidence: Math.min(0.95, 0.45 + Math.log2(evidence.length + 1) * 0.12),
        status: "candidate",
        createdAt: now,
        updatedAt: now,
      };
      database.sqlite.prepare(`
        insert into learning_candidates (
          id, workspace_root, title, trigger, procedure_json, evidence_json,
          confidence, status, validation_note, skill_path, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.id,
        candidate.workspaceRoot,
        candidate.title,
        candidate.trigger,
        JSON.stringify(candidate.procedure),
        JSON.stringify(candidate.evidenceEpisodeIds),
        candidate.confidence,
        candidate.status,
        null,
        null,
        candidate.createdAt,
        candidate.updatedAt,
      );
      return candidate;
    } finally {
      database.close();
    }
  }

  listCandidates(workspaceRoot: string, status?: LearningCandidateStatus): LearningCandidate[] {
    const database = openDatabase(this.stateDir);
    try {
      const rows = status
        ? database.sqlite.prepare(`select * from learning_candidates where workspace_root = ? and status = ? order by updated_at desc`).all(workspaceRoot, status)
        : database.sqlite.prepare(`select * from learning_candidates where workspace_root = ? order by updated_at desc`).all(workspaceRoot);
      return (rows as LearningCandidateRow[]).map(rowToCandidate);
    } finally {
      database.close();
    }
  }

  getCandidate(workspaceRoot: string, candidateId: string): LearningCandidate {
    const database = openDatabase(this.stateDir);
    try {
      const row = database.sqlite.prepare(`
        select * from learning_candidates where workspace_root = ? and id = ?
      `).get(workspaceRoot, candidateId) as LearningCandidateRow | undefined;
      if (!row) throw new Error(`Unknown learning candidate: ${candidateId}`);
      return rowToCandidate(row);
    } finally {
      database.close();
    }
  }

  async promote(
    workspaceRoot: string,
    candidateId: string,
    validationNote: string,
  ): Promise<LearningCandidate> {
    const candidate = this.getCandidate(workspaceRoot, candidateId);
    if (candidate.status === "rejected") throw new Error("Rejected learning candidates cannot be promoted.");
    const note = validationNote.trim();
    if (!note) throw new Error("Promotion requires a validation note describing current evidence or tests.");
    const slug = skillSlug(candidate.title);
    const relative = `.agents/skills/${slug}/SKILL.md`;
    const absolute = path.join(workspaceRoot, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, renderSkill(candidate), { mode: 0o644 });

    const database = openDatabase(this.stateDir);
    try {
      const updatedAt = new Date().toISOString();
      database.sqlite.prepare(`
        update learning_candidates
        set status = 'promoted', validation_note = ?, skill_path = ?, updated_at = ?
        where workspace_root = ? and id = ?
      `).run(note, relative, updatedAt, workspaceRoot, candidateId);
    } finally {
      database.close();
    }
    return this.getCandidate(workspaceRoot, candidateId);
  }

  reject(workspaceRoot: string, candidateId: string, note = ""): LearningCandidate {
    this.getCandidate(workspaceRoot, candidateId);
    const database = openDatabase(this.stateDir);
    try {
      database.sqlite.prepare(`
        update learning_candidates
        set status = 'rejected', validation_note = ?, updated_at = ?
        where workspace_root = ? and id = ?
      `).run(note.trim() || null, new Date().toISOString(), workspaceRoot, candidateId);
    } finally {
      database.close();
    }
    return this.getCandidate(workspaceRoot, candidateId);
  }

  stats(workspaceRoot: string): { episodes: number; successful: number; candidates: number; promoted: number } {
    const database = openDatabase(this.stateDir);
    try {
      const episode = database.sqlite.prepare(`
        select count(*) as total, sum(case when success = 1 then 1 else 0 end) as successful
        from learning_episodes where workspace_root = ?
      `).get(workspaceRoot) as { total: number; successful: number | null };
      const candidate = database.sqlite.prepare(`
        select count(*) as total, sum(case when status = 'promoted' then 1 else 0 end) as promoted
        from learning_candidates where workspace_root = ?
      `).get(workspaceRoot) as { total: number; promoted: number | null };
      return {
        episodes: episode.total,
        successful: episode.successful ?? 0,
        candidates: candidate.total,
        promoted: candidate.promoted ?? 0,
      };
    } finally {
      database.close();
    }
  }
}

interface LearningEpisodeRow {
  id: string;
  workspace_root: string;
  conversation_scope_id: string | null;
  tool: string;
  input_summary: string;
  output_summary: string;
  success: number;
  created_at: string;
}

interface LearningCandidateRow {
  id: string;
  workspace_root: string;
  title: string;
  trigger: string;
  procedure_json: string;
  evidence_json: string;
  confidence: number;
  status: LearningCandidateStatus;
  validation_note: string | null;
  skill_path: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEpisode(row: LearningEpisodeRow): LearningEpisode {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    conversationScopeId: row.conversation_scope_id ?? undefined,
    tool: row.tool,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    success: row.success === 1,
    createdAt: row.created_at,
  };
}

function rowToCandidate(row: LearningCandidateRow): LearningCandidate {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    title: row.title,
    trigger: row.trigger,
    procedure: JSON.parse(row.procedure_json) as string[],
    evidenceEpisodeIds: JSON.parse(row.evidence_json) as string[],
    confidence: row.confidence,
    status: row.status,
    validationNote: row.validation_note ?? undefined,
    skillPath: row.skill_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summarizeInput(tool: string, value: unknown): string {
  const input = recordValue(value);
  let summary: unknown;
  if (tool === "exec_command") {
    summary = { cmd: input.cmd, workingDirectory: input.workingDirectory };
  } else if (tool === "bash") {
    summary = { command: input.command, workingDirectory: input.workingDirectory };
  } else if (tool === "apply_patch") {
    summary = { patchBytes: typeof input.patch === "string" ? Buffer.byteLength(input.patch, "utf8") : 0 };
  } else if (tool === "write") {
    summary = { path: input.path, contentBytes: typeof input.content === "string" ? Buffer.byteLength(input.content, "utf8") : 0 };
  } else if (tool === "edit") {
    summary = { path: input.path, editCount: Array.isArray(input.edits) ? input.edits.length : 0 };
  } else {
    summary = Object.fromEntries(Object.entries(input).filter(([key]) => !["workspaceId", "body", "content", "patch", "edits"].includes(key)));
  }
  return truncate(redactSecrets(JSON.stringify(summary)), MAX_INPUT_CHARS);
}

function summarizeOutput(value: unknown): string {
  const result = recordValue(value);
  const structured = recordValue(result.structuredContent);
  const primary = typeof structured.result === "string"
    ? structured.result
    : Array.isArray(result.content)
      ? result.content.map((item) => recordValue(item).text).filter((item): item is string => typeof item === "string").join("\n")
      : JSON.stringify(structured);
  return truncate(redactSecrets(primary || "ok"), MAX_OUTPUT_CHARS);
}

function responseIsError(value: unknown): boolean {
  return recordValue(value).isError === true;
}

function queryTokens(query: string): string[] {
  return uniqueStrings(query.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u)).filter((token) => token.length >= 2);
}

function textScore(tokens: string[], text: string): number {
  if (tokens.length === 0) return 0;
  const normalized = text.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0) / tokens.length;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 40) / 2);
  return `${value.slice(0, half)}\n... learning trace truncated ...\n${value.slice(-half)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function skillSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || `learned-${randomUUID().slice(0, 8)}`;
}

function renderSkill(candidate: LearningCandidate): string {
  return [
    "---",
    `name: ${skillSlug(candidate.title)}`,
    `description: ${yamlScalar(candidate.trigger)}`,
    "---",
    "",
    `# ${candidate.title}`,
    "",
    "This skill was promoted from verified DevSpace learning evidence.",
    "",
    "## Procedure",
    "",
    ...candidate.procedure.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Provenance",
    "",
    `Candidate: \`${candidate.id}\``,
    `Evidence episodes: ${candidate.evidenceEpisodeIds.map((id) => `\`${id}\``).join(", ")}`,
    "",
  ].join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
