import { createHash } from "node:crypto";
import type { DiagnosticEntry } from "./diagnostic-trace.js";
import type { HourlyUsage, StoredReview } from "./usage-ledger.js";

/** Read-only, evidence-labeled usage stats. Neither MCP bytes nor Git reviews measure model inference tokens. */
export interface UsageEpisode {
  workspace_root: string;
  tool: string;
  output_summary: string;
  success: number;
  created_at: string;
}
export type UsagePeriod = "24h" | "7d" | "30d";
export interface UsageTotals {
  requests: number;
  completed: number;
  toolExecutions: number;
  inputBytes: number;
  outputBytes: number;
  measuredInput: number;
  measuredOutput: number;
  payloadTokenEquivalentInput: number;
  payloadTokenEquivalentOutput: number;
  gitReviews: number;
  reviewedFileTouches: number;
  distinctReviewedFiles: number;
  distinctFileCountComplete: boolean;
  addedLines: number;
  removedLines: number;
  otherEditOperations: number;
  projects: Array<{ id: string; name: string; reviews: number; fileTouches: number; uniqueFiles: number;
    addedLines: number; removedLines: number; editOperations: number }>;
  topTools: Array<{ tool: string; calls: number }>;
  trends: Array<{ day: string; requests: number; toolExecutions: number; addedLines: number; removedLines: number }>;
}
export interface ConsoleUsage {
  source: { diagnosticFirstAt: string | null; episodeFirstAt: string | null; diagnosticsCapped: boolean; episodesCapped: boolean;
    trafficPersistedFrom: string | null; codePersistedFrom: string | null; codeReviewsCapped: boolean };
  periods: Record<UsagePeriod, UsageTotals>;
  inference: { inputTokens: null; outputTokens: null; model: null; explanation: string };
}

const DAY_MS = 86_400_000;
const OFFSETS: Record<UsagePeriod, number> = { "24h": 1, "7d": 7, "30d": 30 };
const EDIT_TOOLS = new Set(["apply_patch", "semantic_edit", "write", "edit", "semantic_code_edit"]);
const USAGE_MARKER = "@@synrex-usage:";

export function gitUsage(output: string): {
  reviewRef: string; files: number; additions: number; removals: number;
  pathHashes: string[]; pathsComplete: boolean;
} | null {
  const marker = output.lastIndexOf(USAGE_MARKER);
  if (marker < 0) return null;
  try {
    const obj: unknown = JSON.parse(output.slice(marker + USAGE_MARKER.length));
    if (!obj || typeof obj !== "object") return null;
    const v = obj as Record<string, unknown>;
    if (typeof v.reviewRef !== "string" || !/^[a-f0-9]{40,64}$/.test(v.reviewRef)) return null;
    if (![v.files, v.additions, v.removals].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
    return {
      reviewRef: v.reviewRef, files: v.files as number, additions: v.additions as number,
      removals: v.removals as number, pathsComplete: v.pathsComplete === true,
      pathHashes: Array.isArray(v.pathHashes) ? v.pathHashes.filter((p): p is string => typeof p === "string" && /^[a-f0-9]{20}$/.test(p)).slice(0, 50) : [],
    };
  } catch { return null; }
}

export function summarizeConsoleUsage(
  events: DiagnosticEntry[], episodes: UsageEpisode[], now = Date.now(), caps = { diagnostics: false, episodes: false },
  stored: { hourly: HourlyUsage[]; reviews: StoredReview[] } = { hourly: [], reviews: [] },
): ConsoleUsage {
  const byRequest = new Map<string, DiagnosticEntry[]>();
  for (const event of events) {
    const id = event.traceId ?? event.requestId;
    if (!id) continue;
    const group = byRequest.get(id) ?? [];
    group.push(event);
    byRequest.set(id, group);
  }
  const requests = [...byRequest.values()].filter(entries => entries.some(e => e.event === "mcp_received")).map(entries => {
    const first = entries.find(e => e.event === "mcp_received")!;
    const finish = entries.find(e => e.event === "mcp_finished");
    return {
      at: Date.parse(first.ts), completed: Boolean(finish),
      input: entries.find(e => e.event === "mcp_received" && e.inputBytes !== undefined)?.inputBytes ?? 0,
      output: finish?.outputBytes ?? 0,
      tools: entries.filter(e => e.event === "tool_execution_started").length,
      toolNames: entries.filter(e => e.event === "tool_execution_started" && e.tool).map(e => e.tool!),
    };
  });
  const firstStoredHour = stored.hourly[0]?.hour;
  const usableRequests = firstStoredHour ? requests.filter(r => r.at < Date.parse(firstStoredHour)) : requests;
  const persistentReviews: UsageEpisode[] = stored.reviews.slice(0, 5000).map(r => ({
    workspace_root: r.workspace_root, tool: "show_changes", success: 1, created_at: r.created_at,
    output_summary: `${USAGE_MARKER}${JSON.stringify({ reviewRef: r.review_ref, files: r.files,
      additions: r.additions, removals: r.removals,
      pathHashes: (() => { try { return JSON.parse(r.path_hashes_json) as unknown; } catch { return []; } })(),
      pathsComplete: r.paths_complete === 1 })}`,
  }));
  const allEdits = [...persistentReviews, ...episodes];
  const periods = {} as Record<UsagePeriod, UsageTotals>;
  for (const [period, days] of Object.entries(OFFSETS) as Array<[UsagePeriod, number]>) {
    const cutoff = now - days * DAY_MS;
    const current = usableRequests.filter(r => r.at >= cutoff && r.at <= now && Number.isFinite(r.at));
    const saved = stored.hourly.filter(r => Date.parse(r.hour) >= cutoff && Date.parse(r.hour) <= now);
    const edits = allEdits.filter(e => {
      const at = Date.parse(e.created_at);
      return at >= cutoff && at <= now && Number.isFinite(at);
    });
    const byDay = new Map<string, UsageTotals["trends"][number]>();
    function dayOf(at: number) {
      const day = new Date(at).toISOString().slice(0, 10);
      let bin = byDay.get(day);
      if (!bin) { bin = { day, requests: 0, toolExecutions: 0, addedLines: 0, removedLines: 0 }; byDay.set(day, bin); }
      return bin;
    }
    let inputBytes = 0, outputBytes = 0, completed = 0, toolExecutions = 0;
    let measuredInput = 0, measuredOutput = 0;
    const toolCounts = new Map<string, number>();
    for (const r of current) {
      const bin = dayOf(r.at);
      bin.requests++;
      bin.toolExecutions += r.tools;
      inputBytes += Math.max(0, r.input);
      outputBytes += Math.max(0, r.output);
      if(r.input > 0)measuredInput++;
      if(r.completed && r.output > 0)measuredOutput++;
      toolExecutions += r.tools;
      for (const name of r.toolNames) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      if (r.completed) completed++;
    }
    for (const r of saved) {
      const bin = dayOf(Date.parse(r.hour));
      bin.requests += r.requests;
      bin.toolExecutions += r.tool_calls;
      inputBytes += r.input_bytes;
      outputBytes += r.output_bytes;
      measuredInput += r.input_measured;
      measuredOutput += r.output_measured;
      completed += r.completed;
      toolExecutions += r.tool_calls;
      try {
        const names = JSON.parse(r.tool_counts_json) as Record<string, number>;
        for (const [name,count] of Object.entries(names)) {
          if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
        }
      } catch { /* Bad optional distribution data is ignored. */ }
    }
    const seenReviews = new Set<string>();
    const uniqueFiles = new Set<string>();
    let gitReviews = 0, reviewedFileTouches = 0, addedLines = 0, removedLines = 0, otherEditOperations = 0;
    let distinctFileCountComplete = true;
    const projects = new Map<string, UsageTotals["projects"][number]>();
    const projectFileKeys = new Map<string, Set<string>>();
    function project(root: string) {
      let value = projects.get(root);
      if (!value) {
        value = { id: createHash("sha256").update(root).digest("hex").slice(0, 16),
          name: root.split(/[\\/]/).filter(Boolean).at(-1) ?? "project", reviews: 0,
          fileTouches: 0, uniqueFiles: 0, addedLines: 0, removedLines: 0, editOperations: 0 };
        projects.set(root, value);
      }
      return value;
    }
    for (const e of edits) {
      if (e.success !== 1) continue;
      if (EDIT_TOOLS.has(e.tool)) { otherEditOperations++; project(e.workspace_root).editOperations++; continue; }
      if (e.tool !== "show_changes") continue;
      const info = gitUsage(e.output_summary);
      if (!info) continue; // Older reviews have no structured Git counts.
      const reviewKey = `${e.workspace_root}:${info.reviewRef}`;
      if (seenReviews.has(reviewKey)) continue;
      seenReviews.add(reviewKey);
      gitReviews++;
      const group = project(e.workspace_root);
      group.reviews++; group.fileTouches += info.files; group.addedLines += info.additions; group.removedLines += info.removals;
      reviewedFileTouches += info.files;
      addedLines += info.additions;
      removedLines += info.removals;
      if (!info.pathsComplete) distinctFileCountComplete = false;
      const projectFiles = projectFileKeys.get(e.workspace_root) ?? new Set<string>();
      projectFileKeys.set(e.workspace_root, projectFiles);
      for (const hash of info.pathHashes) {
        uniqueFiles.add(`${e.workspace_root}:${hash}`);
        projectFiles.add(hash);
      }
      const bin = dayOf(Date.parse(e.created_at));
      bin.addedLines += info.additions;
      bin.removedLines += info.removals;
    }
    periods[period] = {
      requests: current.length + saved.reduce((sum, r) => sum + r.requests, 0), completed, toolExecutions,
      inputBytes, outputBytes, measuredInput, measuredOutput,
      // Traffic-equivalent estimates, not inference usage. A byte/4 conversion
      // is a rough text-only proxy and is not valid as a model billable-token count.
      payloadTokenEquivalentInput: Math.round(inputBytes / 4),
      payloadTokenEquivalentOutput: Math.round(outputBytes / 4),
      gitReviews, reviewedFileTouches, distinctReviewedFiles: uniqueFiles.size,
      distinctFileCountComplete, addedLines, removedLines, otherEditOperations,
      projects: [...projects.entries()].map(([root, p]) => ({ ...p, uniqueFiles: projectFileKeys.get(root)?.size ?? 0 }))
        .sort((a,b)=>b.addedLines+b.removedLines-a.addedLines-a.removedLines).slice(0,40),
      topTools: [...toolCounts].map(([tool, calls]) => ({ tool, calls })).sort((a,b) => b.calls-a.calls).slice(0, 8),
      trends: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
  }
  return {
    source: {
      diagnosticFirstAt: events.length ? events[0]!.ts : null,
      episodeFirstAt: episodes.length ? episodes[episodes.length - 1]!.created_at : null,
      diagnosticsCapped: caps.diagnostics,
      episodesCapped: caps.episodes,
      trafficPersistedFrom: firstStoredHour ?? null,
      codePersistedFrom: stored.reviews.at(-1)?.created_at ?? null,
      codeReviewsCapped: stored.reviews.length > 5000,
    },
    periods,
    inference: { inputTokens: null, outputTokens: null, model: null,
      explanation: "Ordinary ChatGPT does not expose model inference/cache/reasoning token usage or model identity to the Synrex MCP server." },
  };
}
