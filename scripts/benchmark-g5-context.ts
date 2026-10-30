/**
 * G5 paired B (ordinary Subagent) / C2 (Context Pack Subagent).
 * Five real-repository, read-only engineering investigations, five repeats.
 * A = GPT Direct is NOT emulated. Resume safely from an append-only JSONL.
 * Usage: SYNREX_G5_BENCH=1 tsx scripts/benchmark-g5-context.ts <results.jsonl> [repeats=5]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityLocalAgentDriver } from "../src/local-agent-antigravity.js";
import { LocalAgentContextPacks } from "../src/local-agent-context-pack.js";
import { LocalAgentManager } from "../src/local-agent-manager.js";
import { LocalAgentEvidenceStore } from "../src/local-agent-evidence.js";
import { LocalAgentRuntimePool } from "../src/local-agent-runtime-pool.js";
import { LocalAgentStore } from "../src/local-agent-store.js";
import { CodingWorkflowStore } from "../src/coding-workflows.js";

if (process.env.SYNREX_G5_BENCH !== "1") throw new Error("SYNREX_G5_BENCH=1 required.");
const outputPath = process.argv[2];
const repeats = Number(process.argv[3] ?? "5");
if (!outputPath || !Number.isInteger(repeats) || repeats < 1 || repeats > 5) {
  throw new Error("Usage: benchmark-g5-context.ts <results.jsonl> [repeats 1..5]");
}
const cwd = resolve(process.cwd());
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf8" }).trim();
if (dirty) throw new Error("G5 requires a clean committed source baseline.");
const model = process.env.ANTIGRAVITY_MODEL ?? "gemini-3.8-flash-medium";
const tasks = [
  {
    id: "runtime-interface", file: "src/local-agent-runtime.ts",
    question: "Find the interface specifying run(), isAlive(), close() and releaseSession(). Reply with its exact interface identifier only.",
    expected: "LocalAgentRuntime",
  },
  {
    id: "semantic-manager", file: "src/serena-semantic.ts",
    question: "Find the exported class that manages pooled Serena MCP clients for symbol queries. Reply with its exact class identifier only.",
    expected: "SerenaSemanticManager",
  },
  {
    id: "workflow-resume", file: "src/coding-workflows.ts",
    question: "Find the CodingWorkflowStore method that retrieves a workflow or throws if it is missing from a workspace. Reply with the method name only.",
    expected: "getRequired",
  },
  {
    id: "evidence-recovery", file: "src/local-agent-evidence.ts",
    question: "Find the private method that locates immutable evidence files when the latest pointer is missing. Reply with the method name only.",
    expected: "recoverLatest",
  },
  {
    id: "context-engine", file: "src/local-agent-context-pack.ts",
    question: "Find the exported class that builds content-addressed context packs for task handoff. Reply with the class identifier only.",
    expected: "LocalAgentContextPacks",
  },
] as const;
const maxRuns = Math.min(50, Math.max(1, Number(process.env.SYNREX_G5_MAX_RUNS ?? 50)));
const existingRows = existsSync(outputPath)
  ? readFileSync(outputPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  : [];
const completed = new Set(existingRows.filter((row) =>
  row.baseline === revision && row.model === model).map((row) =>
    String(row.taskId) + "/" + String(row.trial) + "/" + String(row.architecture)));
let attempted = 0;
const scratch = mkdtempSync(join(tmpdir(), "synrex-g5-bc2-"));
const stateDir = join(scratch, "state");
const scope = { workspaceId: "ws_g5_benchmark", workspaceRoot: cwd };
const contextPacks = new LocalAgentContextPacks(stateDir);
const manager = new LocalAgentManager({
  store: new LocalAgentStore(stateDir),
  evidenceStore: new LocalAgentEvidenceStore(stateDir),
  contextPacks,
  drivers: [new AntigravityLocalAgentDriver({
    ...process.env, ANTIGRAVITY_MODEL: model,
    ANTIGRAVITY_COMMAND: process.env.ANTIGRAVITY_COMMAND ?? "/home/swy/.local/bin/agy",
  })],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [],
  allowedRoots: [cwd],
  subagents: {
    enabled: true, instructions: "on-demand",
    providers: [{ id: "antigravity", enabled: true, model }],
  },
});
try {
  const workflows = new CodingWorkflowStore(stateDir);
  const workflowByTask = new Map<string, string>();
  for (const task of tasks) {
    const wf = workflows.create(cwd, {
      title: task.id, goal: task.question,
      acceptanceCriteria: ["Answer the exact identifier."],
      constraints: ["Read-only; do not modify source."],
      requestKey: "g5-" + task.id,
    });
    workflowByTask.set(task.id, wf.workflowId);
  }
  workflows.close();
  outer: for (const task of tasks) {
    for (let trial = 1; trial <= repeats; trial++) {
      const order = trial % 2 === 1 ? ["B", "C2"] as const : ["C2", "B"] as const;
      for (const architecture of order) {
        if (attempted >= maxRuns) break outer;
        const key = task.id + "/" + trial + "/" + architecture;
        if (completed.has(key)) continue;
        const prompt = task.question + " The source file is " + task.file +
          ". Do not modify the repository.";
        const context = architecture === "C2" ? {
          context: {
            workflowId: workflowByTask.get(task.id),
            files: [task.file], maxBytes: 4_000,
          },
        } : {};
        const started = performance.now();
        const accepted = await manager.start({
          target: "antigravity", prompt, ...scope,
          writeMode: "read_only", ...context,
        });
        if (accepted.isErr()) throw accepted.error;
        let observation = accepted.value;
        const deadline = Date.now() + 200_000;
        while (observation.status === "running" || observation.status === "starting") {
          if (Date.now() >= deadline) throw new Error("Benchmark agent stalled beyond deadline.");
          await new Promise((done) => setTimeout(done, 350));
          const result = manager.get(observation.id, scope, { includeEvidence: true });
          if (result.isErr()) throw result.error;
          observation = result.value;
        }
        const totalMs = Math.round(performance.now() - started);
        const response = observation.latestResponse?.trim() ?? "";
        const firstPass = observation.status === "idle" && response.includes(task.expected);
        let provider: Record<string, unknown> = {};
        try {
          const events = JSON.parse(observation.evidence?.itemsJson ?? "[]") as Array<{
            type?: string; data?: Record<string, unknown>;
          }>;
          provider = events.find((item) => item.type === "provider_json_result")?.data ?? {};
        } catch { /* Null means unavailable, not zero. */ }
        const row = {
          kind: "g5-real-repository-read-only", baseline: revision,
          taskId: task.id, trial, architecture, model, expected: task.expected,
          totalMs, firstPass, responseExact: response === task.expected,
          status: observation.status, errorCode: observation.errorCode ?? null,
          evidenceRef: observation.evidenceSummary?.ref ?? null,
          context: observation.evidence?.context ?? null,
          providerUsage: provider.usage ?? null, reportedTurns: provider.num_turns ?? null,
          deniedActions: provider.denied_actions ?? null,
          gptTokens: null, modelToolCalls: null, modelDuplicateReads: null,
          rework: null, codeQuality: null, response: response.slice(0, 360),
        };
        appendFileSync(outputPath, JSON.stringify(row) + "\n", { mode: 0o600 });
        completed.add(key);
        attempted++;
        console.log(JSON.stringify({
          task: task.id, trial, architecture, firstPass, totalMs,
          prefetchReads: observation.evidence?.context?.filesRead ?? null,
          cacheHits: observation.evidence?.context?.sourceCacheHits ?? null,
        }));
      }
    }
  }
} finally {
  await manager.close();
  rmSync(scratch, { recursive: true, force: true });
}
