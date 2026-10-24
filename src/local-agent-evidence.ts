import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentContextMetrics } from "./local-agent-context-pack.js";

// Private execution artifacts, not a second workflow or model-memory store.
const MAX_PROVIDER_ITEMS_BYTES = 256 * 1024;
const AGENT_ID = /^agt_[a-f0-9]{8}$/;
const EVIDENCE_REF = /^ev_[a-f0-9]{32}$/;

export interface AgentGitObservation {
  head?: string;
  status?: string;
}

export interface AgentEvidenceSummary {
  ref: string;
  outcome: "completed" | "failed";
  provider: string;
  observedAt: string;
  itemCount: number;
  itemsTruncated: boolean;
  sha256: string;
  context?: AgentContextMetrics;
}

export interface AgentEvidenceArtifact extends AgentEvidenceSummary {
  v: 1;
  agentId: string;
  workspaceRoot: string;
  model?: string;
  startedAt: string;
  gitBefore?: AgentGitObservation;
  gitAfter?: AgentGitObservation;
  // Provider output is untrusted and stored privately; it is not a test oracle.
  answerPreview?: string;
  error?: string;
  itemsJson: string;
}

export function captureAgentGit(root: string): AgentGitObservation {
  const run = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch { return undefined; }
  };
  const head = run("rev-parse", "--verify", "HEAD");
  if (!head) return {};
  return {
    head,
    status: run("status", "--porcelain=v1", "--untracked-files=normal")?.slice(0, 12000),
  };
}

export class LocalAgentEvidenceStore {
  private readonly root: string;

  constructor(stateDir: string) {
    this.root = join(resolve(stateDir), "agent-evidence");
  }

  save(input: {
    agentId: string;
    provider: string;
    workspaceRoot: string;
    model?: string;
    startedAt: string;
    outcome: "completed" | "failed";
    response?: string;
    error?: string;
    items?: unknown[];
    gitBefore?: AgentGitObservation;
    gitAfter?: AgentGitObservation;
    context?: AgentContextMetrics;
  }): AgentEvidenceSummary {
    const dir = this.agentDir(input.agentId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ref = `ev_${randomUUID().replaceAll("-", "")}`;
    const allItems = input.items ?? [];
    let itemsJson: string;
    let serializationLost = false;
    try { itemsJson = JSON.stringify(allItems); }
    catch {
      serializationLost = true;
      itemsJson = JSON.stringify(["Provider returned non-serializable items"]);
    }
    const sha256 = createHash("sha256").update(itemsJson).digest("hex");
    const itemsTruncated = serializationLost || Buffer.byteLength(itemsJson, "utf8") > MAX_PROVIDER_ITEMS_BYTES;
    if (itemsTruncated) {
      // UTF-8 truncation is explicit and never represented as complete events.
      itemsJson = Buffer.from(itemsJson, "utf8").subarray(0, MAX_PROVIDER_ITEMS_BYTES).toString("utf8");
    }
    const artifact: AgentEvidenceArtifact = {
      v: 1,
      ref,
      agentId: input.agentId,
      provider: input.provider,
      workspaceRoot: resolve(input.workspaceRoot),
      ...(input.model ? { model: input.model } : {}),
      startedAt: input.startedAt,
      observedAt: new Date().toISOString(),
      outcome: input.outcome,
      itemCount: allItems.length,
      itemsTruncated,
      sha256,
      ...(input.gitBefore ? { gitBefore: input.gitBefore } : {}),
      ...(input.gitAfter ? { gitAfter: input.gitAfter } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.response ? { answerPreview: input.response.slice(0, 2000) } : {}),
      ...(input.error ? { error: input.error.slice(0, 4000) } : {}),
      itemsJson,
    };
    writeFileSync(join(dir, `${ref}.json`), JSON.stringify(artifact), {
      mode: 0o600,
      flag: "wx",
    });
    // The latest pointer can be recreated by an agent inspection if a crash
    // occurs between the immutable evidence write and pointer publication.
    const temp = join(dir, `latest.${ref}.tmp`);
    writeFileSync(temp, ref, { mode: 0o600, flag: "wx" });
    renameSync(temp, join(dir, "latest"));
    return summary(artifact);
  }

  latest(agentId: string): AgentEvidenceSummary | undefined {
    const dir = this.agentDir(agentId);
    let ref: string;
    try { ref = readFileSync(join(dir, "latest"), "utf8").trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.recoverLatest(agentId, dir);
      }
      throw error;
    }
    return summary(this.read(agentId, ref));
  }

  private recoverLatest(agentId: string, dir: string): AgentEvidenceSummary | undefined {
    // A crash between immutable file creation and latest-pointer rename
    // must not erase the evidence. Rebuild the *read view* without replay.
    let candidates: string[];
    try { candidates = readdirSync(dir).filter((name) => /^ev_[a-f0-9]{32}\.json$/.test(name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const byMtime = candidates.map((name) => {
      try { return { name, mtime: statSync(join(dir, name)).mtimeMs }; }
      catch { return { name, mtime: 0 }; }
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 128);
    for (const candidate of byMtime) {
      try { return summary(this.read(agentId, candidate.name.slice(0, -5))); }
      catch { /* corrupt candidate; inspect the next */ }
    }
    return undefined;
  }

  read(agentId: string, ref: string): AgentEvidenceArtifact {
    if (!EVIDENCE_REF.test(ref)) throw new Error("Invalid agent evidence reference.");
    const value = JSON.parse(readFileSync(join(this.agentDir(agentId), `${ref}.json`), "utf8")) as AgentEvidenceArtifact;
    if (value.agentId !== agentId || value.ref !== ref || value.v !== 1) {
      throw new Error("Agent evidence identity mismatch.");
    }
    return value;
  }

  private agentDir(agentId: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error("Invalid agent evidence owner.");
    return join(this.root, agentId);
  }
}

function summary(value: AgentEvidenceArtifact): AgentEvidenceSummary {
  return {
    ref: value.ref,
    outcome: value.outcome,
    provider: value.provider,
    observedAt: value.observedAt,
    itemCount: value.itemCount,
    itemsTruncated: value.itemsTruncated,
    sha256: value.sha256,
    ...(value.context ? { context: value.context } : {}),
  };
}
