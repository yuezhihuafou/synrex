import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "./db/client.js";
import { gitUsage } from "./console-usage.js";
import { recordCodeReview } from "./usage-ledger.js";

// Additive, lazy table creation deliberately does not advance the shared
// strict migration version. Older pinned releases must remain able to open
// this same SQLite database during rollback.
function openNotesDatabase(stateDir: string) {
  const db = openDatabase(stateDir);
  try {
    db.sqlite.exec(`
      create table if not exists learning_notes (
        id text primary key,
        workspace_root text not null,
        task_key text not null,
        source text not null,
        title text not null,
        outcome text not null,
        summary text not null,
        root_cause text,
        resolution_json text not null,
        lessons_json text not null,
        checks_json text not null,
        next_steps_json text not null,
        evidence_json text not null,
        created_at text not null,
        updated_at text not null,
        unique(workspace_root, task_key)
      );
      create index if not exists learning_notes_workspace_updated_idx
        on learning_notes(workspace_root, updated_at desc);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const MAX_EPISODES_PER_WORKSPACE = 2_000;
const MAX_INPUT_CHARS = 1_200;
const MAX_OUTPUT_CHARS = 2_000;

// Before detached exec replies were excluded from learning, some releases
// stored "task=... working" as success=1. Preserve the raw event, but never
// treat a dispatch acknowledgment as completed verification on read.
// Use the same predicate for SQLite summaries and evidence eligibility.
export const LEGACY_UNVERIFIED_DISPATCH_SQL = `(tool in ('exec_command', 'bash')
  and (output_summary like 'task=task_% working%'
    or output_summary like 'task=task_% input_required%'))`;

function isLegacyUnverifiedDispatch(value: { tool: string; output_summary: string }): boolean {
  return (value.tool === "exec_command" || value.tool === "bash")
    && /^task=task_[a-z0-9-]+\s+(?:working|input_required)\b/i.test(value.output_summary);
}

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
  status: LearningCandidateStatus;
  validationNote?: string;
  skillPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningRecallResult {
  episodes: LearningEpisode[];
  candidates: LearningCandidate[];
  notes: LearningNote[];
}

/** A task-level retrospective, distinct from a raw tool receipt or a
 * validated project skill. Workflow checkpoints are self-reported; neither
 * their checks nor their conclusions are promoted to verified evidence.
 */
export interface LearningNote {
  id: string;
  workspaceRoot: string;
  taskKey: string;
  source: "workflow" | "reflection";
  title: string;
  outcome: string;
  summary: string;
  rootCause?: string;
  resolution: string[];
  lessons: string[];
  checks: string[];
  nextSteps: string[];
  evidenceEpisodeIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedProcedureSuggestion {
  command: string;
  occurrences: number;
  evidenceEpisodeIds: string[];
  lastVerifiedAt: string;
  proposedProcedure: string[];
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
    // A detached command returning a task handle has not passed its check.
    // The durable task ledger owns the eventual outcome; do not convert a
    // successful MCP dispatch into a false verification episode.
    if ((input.tool === "exec_command" || input.tool === "bash")
      && responseIsPending(input.toolOutput)) return;
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
          : summarizeOutput(input.toolOutput, input.tool),
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
      if (episode.tool === "show_changes" && episode.success) {
        const review = gitUsage(episode.outputSummary);
        if (review) recordCodeReview(database.sqlite, {
          workspace_root: episode.workspaceRoot, review_ref: review.reviewRef, created_at: episode.createdAt,
          files: review.files, additions: review.additions, removals: review.removals,
          path_hashes_json: JSON.stringify(review.pathHashes), paths_complete: review.pathsComplete ? 1 : 0,
        });
      }
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
        where workspace_root = ? and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}
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
        .map((candidate) => ({
          candidate,
          score: textScore(tokens, `${candidate.title} ${candidate.trigger} ${candidate.procedure.join(" ")}`)
            + Math.min(0.2, Math.log2(candidate.evidenceEpisodeIds.length + 1) * 0.03),
        }))
        .filter((item) => tokens.length === 0 || item.score > 0)
        .sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 20)))
        .map((item) => item.candidate);
      const notes = this.listNotes(workspaceRoot, 60)
        .map((note) => ({
          note,
          score: textScore(tokens, `${note.title} ${note.summary} ${note.rootCause ?? ""} ${note.resolution.join(" ")} ${note.lessons.join(" ")}`),
        }))
        .filter((item) => tokens.length === 0 || item.score > 0)
        .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 20)))
        .map((item) => item.note);
      return { episodes, candidates, notes };
    } finally {
      database.close();
    }
  }

  /** Idempotent, per-workspace task summary. Does not trust a checkpoint's
   * claimed checks as machine verification. No model or network is invoked.
   */
  recordNote(input: {
    workspaceRoot: string;
    taskKey: string;
    source: LearningNote["source"];
    title: string;
    outcome: string;
    summary: string;
    rootCause?: string;
    resolution?: string[];
    lessons?: string[];
    checks?: string[];
    nextSteps?: string[];
    evidenceEpisodeIds?: string[];
  }): LearningNote {
    const taskKey = input.taskKey.trim();
    if (!taskKey || taskKey.length > 200 || !input.title.trim() || !input.summary.trim()) {
      throw new Error("Learning notes require a bounded taskKey, title and summary.");
    }
    const evidence = uniqueStrings(input.evidenceEpisodeIds ?? []).slice(0, 50);
    const db = openNotesDatabase(this.stateDir);
    try {
      if (evidence.length) {
        const found = db.sqlite.prepare(`select id from learning_episodes
          where workspace_root = ? and id in (${evidence.map(() => "?").join(",")})`)
          .all(input.workspaceRoot, ...evidence) as Array<{ id: string }>;
        if (found.length !== evidence.length) {
          throw new Error("Learning note evidence must belong to the current workspace.");
        }
      }
      const now = new Date().toISOString();
      const id = `note_${randomUUID()}`;
      const cleaned = (s: string, max = 1200) => truncate(redactSecrets(s.trim()), max);
      const cleanedList = (values: string[] | undefined) =>
        uniqueStrings(values ?? []).slice(0, 30).map((s) => cleaned(s, 600));
      db.sqlite.prepare(`
        insert into learning_notes (
          id, workspace_root, task_key, source, title, outcome, summary,
          root_cause, resolution_json, lessons_json, checks_json, next_steps_json,
          evidence_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(workspace_root, task_key) do update set
          source=excluded.source, title=excluded.title, outcome=excluded.outcome,
          summary=excluded.summary, root_cause=excluded.root_cause,
          resolution_json=excluded.resolution_json, lessons_json=excluded.lessons_json,
          checks_json=excluded.checks_json, next_steps_json=excluded.next_steps_json,
          evidence_json=excluded.evidence_json, updated_at=excluded.updated_at
      `).run(
        id, input.workspaceRoot, taskKey, input.source, cleaned(input.title, 200),
        cleaned(input.outcome, 40), cleaned(input.summary, 2000),
        input.rootCause ? cleaned(input.rootCause, 1200) : null,
        JSON.stringify(cleanedList(input.resolution)),
        JSON.stringify(cleanedList(input.lessons)),
        JSON.stringify(cleanedList(input.checks)),
        JSON.stringify(cleanedList(input.nextSteps)),
        JSON.stringify(evidence), now, now,
      );
      const row = db.sqlite.prepare("select * from learning_notes where workspace_root = ? and task_key = ?")
        .get(input.workspaceRoot, taskKey) as LearningNoteRow;
      return rowToNote(row);
    } finally {
      db.close();
    }
  }

  listNotes(workspaceRoot: string, limit = 20): LearningNote[] {
    const db = openNotesDatabase(this.stateDir);
    try {
      const rows = db.sqlite.prepare(`select * from learning_notes
        where workspace_root = ? order by updated_at desc limit ?`)
        .all(workspaceRoot, Math.max(1, Math.min(limit, 100))) as LearningNoteRow[];
      return rows.map(rowToNote);
    } finally {
      db.close();
    }
  }

  /**
   * Explicit read-only project recall for a new conversation using a
   * different worktree of the same registered source checkout.
   *
   * Do not merge raw execution episodes, elevate self-reported notes into
   * verified evidence, or silently widen the default workspace boundary.
   * The caller must pass a sourceRoot verified by WorkspaceRegistry; this
   * query additionally demands the stored worktree source_root to match.
   */
  recallSiblingNotes(sourceRoot: string, currentRoot: string, query: string, limit = 6): LearningNote[] {
    const db = openNotesDatabase(this.stateDir);
    try {
      const rows = db.sqlite.prepare(`select * from learning_notes
        where workspace_root <> ?
          and (
            workspace_root = ?
            or workspace_root in (
              select distinct root from workspace_sessions
              where source_root = ? and mode = 'worktree'
            )
          )
        order by updated_at desc limit 120`)
        .all(currentRoot, sourceRoot, sourceRoot) as LearningNoteRow[];
      const tokens = queryTokens(query);
      return rows.map(rowToNote)
        .map((note) => ({
          note,
          score: textScore(tokens, `${note.title} ${note.summary} ${note.rootCause ?? ""} ${note.resolution.join(" ")} ${note.lessons.join(" ")}`),
        }))
        .filter((item) => tokens.length === 0 || item.score > 0)
        .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 8)))
        .map((item) => item.note);
    } finally {
      db.close();
    }
  }

  getNote(workspaceRoot: string, noteId: string): LearningNote {
    const db = openNotesDatabase(this.stateDir);
    try {
      const row = db.sqlite.prepare("select * from learning_notes where workspace_root = ? and id = ?")
        .get(workspaceRoot, noteId) as LearningNoteRow | undefined;
      if (!row) throw new Error(`Unknown learning note in this workspace: ${noteId}`);
      return rowToNote(row);
    } finally {
      db.close();
    }
  }

  /** Digest exposes the actual outcomes rather than pretending that tool
   * traces can explain root causes without GPT's analysis. */
  review(workspaceRoot: string): {
    notes: LearningNote[];
    failures: LearningEpisode[];
    verifiedChecks: VerifiedProcedureSuggestion[];
  } {
    const db = openDatabase(this.stateDir);
    try {
      const failures = (db.sqlite.prepare(`select * from learning_episodes
        where workspace_root = ? and success = 0 and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}
        order by created_at desc limit 12`).all(workspaceRoot) as LearningEpisodeRow[])
        .map(rowToEpisode);
      return { notes: this.listNotes(workspaceRoot, 12),
        failures, verifiedChecks: this.suggestVerifiedProcedures(workspaceRoot, 5) };
    } finally {
      db.close();
    }
  }

  recentSuccessfulEpisodes(workspaceRoot: string, limit = 12): LearningEpisode[] {
    const database = openDatabase(this.stateDir);
    try {
      const rows = database.sqlite.prepare(`
        select * from learning_episodes
        where workspace_root = ? and success = 1 and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}
        order by created_at desc
        limit ?
      `).all(workspaceRoot, Math.max(1, Math.min(limit, 50))) as LearningEpisodeRow[];
      return rows.map(rowToEpisode);
    } finally {
      database.close();
    }
  }

  /** Read-only evidence-first suggestions; no automatic trust or promotion.
   * Repeated verified checks offer reusable hints without manufacturing a
   * broad "learned procedure" from unrelated execution histories.
   */
  suggestVerifiedProcedures(workspaceRoot: string, limit = 5): VerifiedProcedureSuggestion[] {
    const database = openDatabase(this.stateDir);
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      const rows = database.sqlite.prepare(`
        select id, input_summary, created_at from learning_episodes
        where workspace_root = ? and tool = 'exec_command' and success = 1
          and created_at >= ? and not ${LEGACY_UNVERIFIED_DISPATCH_SQL}
        order by created_at desc limit 600
      `).all(workspaceRoot, since) as Array<{ id: string; input_summary: string; created_at: string }>;
      const groups = new Map<string, { evidenceEpisodeIds: string[]; lastVerifiedAt: string; count: number }>();
      for (const row of rows) {
        const cmd = verifiedCheckCommand(row.input_summary);
        if (!cmd) continue;
        const existing = groups.get(cmd);
        if (existing) {
          existing.count++;
          if (existing.evidenceEpisodeIds.length < 5) existing.evidenceEpisodeIds.push(row.id);
        } else groups.set(cmd, { evidenceEpisodeIds: [row.id], lastVerifiedAt: row.created_at, count: 1 });
      }
      return [...groups]
        .filter(([, value]) => value.count >= 2)
        .sort((a, b) => b[1].count - a[1].count || b[1].lastVerifiedAt.localeCompare(a[1].lastVerifiedAt))
        .slice(0, Math.max(1, Math.min(limit, 8)))
        .map(([command, group]) => ({
          command,
          occurrences: group.count,
          evidenceEpisodeIds: group.evidenceEpisodeIds,
          lastVerifiedAt: group.lastVerifiedAt,
          proposedProcedure: [`Run ${command}.`, "Inspect the result and stop if the check fails."],
        }));
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
        select id, success, tool, output_summary from learning_episodes
        where workspace_root = ? and id in (${placeholders})
      `).all(input.workspaceRoot, ...evidence) as Array<{ id: string; success: number; tool: string; output_summary: string }>;
      if (found.length !== evidence.length) {
        throw new Error("One or more evidence episodes do not belong to this workspace or no longer exist.");
      }
      if (found.some((episode) => episode.success !== 1 || isLegacyUnverifiedDispatch(episode))) {
        throw new Error("Learning candidates may use only successful evidence episodes with completed verification, not pending task handles.");
      }
      const now = new Date().toISOString();
      const candidate: LearningCandidate = {
        id: `skillcand_${randomUUID()}`,
        workspaceRoot: input.workspaceRoot,
        title,
        trigger,
        procedure,
        evidenceEpisodeIds: evidence,
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
        0,
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
    if (candidate.status === "promoted") return candidate;
    const note = validationNote.trim();
    if (!note) throw new Error("Promotion requires a validation note describing current evidence or tests.");
    this.assertSuccessfulEvidence(workspaceRoot, candidate.evidenceEpisodeIds);
    this.assertProcedureVerified(workspaceRoot, candidate);
    const slug = skillSlug(candidate.title);
    const relative = `.agents/skills/${slug}/SKILL.md`;
    const absolute = path.join(workspaceRoot, ...relative.split("/"));
    const skill = renderSkill(candidate);
    await mkdir(path.dirname(absolute), { recursive: true });
    try {
      await writeFile(absolute, skill, { mode: 0o644, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(absolute, "utf8");
      if (existing !== skill) {
        throw new Error(
          `Refusing to overwrite existing project skill: ${relative}. Choose a distinct candidate title or review the existing skill.`,
        );
      }
      // An identical file can be left behind by a crash between the skill
      // write and the database update. Treat that as an idempotent retry.
    }

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

  private assertSuccessfulEvidence(workspaceRoot: string, evidenceEpisodeIds: string[]): void {
    if (evidenceEpisodeIds.length === 0) {
      throw new Error("Promotion requires at least one successful evidence episode.");
    }
    const database = openDatabase(this.stateDir);
    try {
      const placeholders = evidenceEpisodeIds.map(() => "?").join(",");
      const rows = database.sqlite.prepare(`
        select id, success, tool, output_summary from learning_episodes
        where workspace_root = ? and id in (${placeholders})
      `).all(workspaceRoot, ...evidenceEpisodeIds) as Array<{ id: string; success: number; tool: string; output_summary: string }>;
      if (rows.length !== evidenceEpisodeIds.length) {
        throw new Error("Promotion evidence no longer exists in the current workspace learning store.");
      }
      if (rows.some((row) => row.success !== 1 || isLegacyUnverifiedDispatch(row))) {
        throw new Error("Promotion evidence must consist only of successful episodes with completed verification, not pending task handles.");
      }
    } finally {
      database.close();
    }
  }

  /** Never turn a plausible-looking note or unrelated successful read into a
   * reusable coding instruction. For now only bounded, explicitly named
   * verification commands qualify; other learning stays a candidate until
   * a richer provenance/approval contract exists. This is a guardrail, not a
   * claim that command success independently proves semantic correctness.
   */
  private assertProcedureVerified(workspaceRoot: string, candidate: LearningCandidate): void {
    const procedure = candidate.procedure.join("\n");
    if (/(?:skip|bypass|disable|ignore|omit|circumvent).{0,35}(?:tests?|review|security|approval|safety|auth|checks?)|(?:跳过|绕过|关闭|忽略).{0,15}(?:测试|审查|安全|审批|授权|校验)/i.test(procedure)) {
      throw new Error("Learning promotion cannot instruct bypassing testing, review, security or approval gates.");
    }
    const database = openDatabase(this.stateDir);
    try {
      const evidence = database.sqlite.prepare(`
        select tool, input_summary, output_summary, created_at from learning_episodes
        where workspace_root = ? and success = 1 and id in (${candidate.evidenceEpisodeIds.map(() => "?").join(",")})
      `).all(workspaceRoot, ...candidate.evidenceEpisodeIds) as Array<{
        tool: string; input_summary: string; output_summary: string; created_at: string;
      }>;
      const verifications = evidence.flatMap((episode) => {
        if (isLegacyUnverifiedDispatch(episode)) return [];
        if (episode.tool !== "exec_command" && episode.tool !== "bash") return [];
        const ageMs = Date.now() - Date.parse(episode.created_at);
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 7 * 24 * 60 * 60_000) return [];
        const clean = verifiedCheckCommand(episode.input_summary);
        return clean ? [clean] : [];
      });
      if (!verifications.length) {
        throw new Error("Learning promotion requires a recent successful test/typecheck/check command from the same workspace; a read or a note is not validation evidence.");
      }
      if (!verifications.some((cmd) => procedure.toLowerCase().includes(cmd.toLowerCase()))) {
        throw new Error("Learning procedure must explicitly name a successful verification command from its cited episodes.");
      }
    } finally {
      database.close();
    }
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

  stats(workspaceRoot: string): { episodes: number; successful: number; notes: number; candidates: number; promoted: number } {
    const database = openNotesDatabase(this.stateDir);
    try {
      const episode = database.sqlite.prepare(`
        select count(*) as total,
          sum(case when success = 1 and not ${LEGACY_UNVERIFIED_DISPATCH_SQL} then 1 else 0 end) as successful
        from learning_episodes where workspace_root = ?
      `).get(workspaceRoot) as { total: number; successful: number | null };
      const candidate = database.sqlite.prepare(`
        select count(*) as total, sum(case when status = 'promoted' then 1 else 0 end) as promoted
        from learning_candidates where workspace_root = ?
      `).get(workspaceRoot) as { total: number; promoted: number | null };
      const notes = database.sqlite.prepare("select count(*) as total from learning_notes where workspace_root = ?")
        .get(workspaceRoot) as { total: number };
      return {
        episodes: episode.total,
        successful: episode.successful ?? 0,
        notes: notes.total,
        candidates: candidate.total,
        promoted: candidate.promoted ?? 0,
      };
    } finally {
      database.close();
    }
  }
}

function verifiedCheckCommand(inputSummary: string): string | undefined {
  let cmd: unknown;
  try {
    const input = JSON.parse(inputSummary) as { cmd?: unknown; command?: unknown };
    cmd = input.cmd ?? input.command;
  } catch { return undefined; }
  if (typeof cmd !== "string") return undefined;
  const clean = cmd.trim().replace(/\s+/g, " ");
  if (clean.length > 180 || /[;&|\n\r]/.test(clean)) return undefined;
  if (!/(?:^|\s)(?:(?:pnpm|npm|yarn|bun)\s+(?:-s\s+)?(?:run\s+)?(?:test|typecheck|lint|check)(?:\s|$)|(?:pytest|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)(?:\s|$))/i.test(clean)) return undefined;
  return clean;
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

interface LearningNoteRow {
  id: string;
  workspace_root: string;
  task_key: string;
  source: LearningNote["source"];
  title: string;
  outcome: string;
  summary: string;
  root_cause: string | null;
  resolution_json: string;
  lessons_json: string;
  checks_json: string;
  next_steps_json: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: LearningNoteRow): LearningNote {
  return {
    id: row.id, workspaceRoot: row.workspace_root, taskKey: row.task_key,
    source: row.source, title: row.title, outcome: row.outcome,
    summary: row.summary, rootCause: row.root_cause ?? undefined,
    resolution: JSON.parse(row.resolution_json) as string[],
    lessons: JSON.parse(row.lessons_json) as string[],
    checks: JSON.parse(row.checks_json) as string[],
    nextSteps: JSON.parse(row.next_steps_json) as string[],
    evidenceEpisodeIds: JSON.parse(row.evidence_json) as string[],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
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

function summarizeOutput(value: unknown, tool?: string): string {
  const result = recordValue(value);
  const structured = recordValue(result.structuredContent);
  const primary = typeof structured.result === "string"
    ? structured.result
    : Array.isArray(result.content)
      ? result.content.map((item) => recordValue(item).text).filter((item): item is string => typeof item === "string").join("\n")
      : JSON.stringify(structured);
  if (tool === "show_changes" && typeof structured.reviewRef === "string" && /^[a-f0-9]{40,64}$/.test(structured.reviewRef)) {
    const card = recordValue(recordValue(result._meta).card);
    const summary = recordValue(card.summary);
    const numbers = [summary.files, summary.additions, summary.removals];
    if (numbers.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 10_000_000)) {
      const files = Array.isArray(card.files) ? card.files : [];
      const paths = files.slice(0, 50).map((f) => recordValue(f).path)
        .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 4096)
        .map((p) => createHash("sha256").update(p).digest("hex").slice(0, 20));
      const usage = { reviewRef: structured.reviewRef, files: numbers[0], additions: numbers[1], removals: numbers[2],
        pathHashes: paths, pathsComplete: files.length === numbers[0] && paths.length === files.length && files.length <= 50 };
      // Only numeric Git counts and hashed filenames are retained; never the patch body.
      // This is a snapshot of reviewed changes, not a claim of successful task completion.
      return truncate(redactSecrets(`${primary.slice(0, 160)}\n@@synrex-usage:${JSON.stringify(usage)}`), MAX_OUTPUT_CHARS);
    }
  }
  return truncate(redactSecrets(primary || "ok"), MAX_OUTPUT_CHARS);
}

function responseIsError(value: unknown): boolean {
  const response = recordValue(value);
  const structured = recordValue(response.structuredContent);
  return response.isError === true
    || structured.isError === true
    || (typeof structured.exitCode === "number" && structured.exitCode !== 0)
    || structured.status === "failed"
    || structured.status === "cancelled";
}

function responseIsPending(value: unknown): boolean {
  const response = recordValue(value);
  const structured = recordValue(response.structuredContent);
  return structured.running === true || structured.status === "working" || structured.status === "input_required";
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
    "This skill was promoted from verified Synrex learning evidence.",
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
