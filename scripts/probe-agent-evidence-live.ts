/**
 * Explicitly invoked, disposable real-Provider smoke for gateway.
 * It does not use the production agent daemon, live state DB or robot workspace.
 * Requires SYNREX_LIVE_AGENT_SMOKE=1; default command is the installed agy.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityLocalAgentDriver } from "../src/local-agent-antigravity.js";
import { LocalAgentManager } from "../src/local-agent-manager.js";
import { LocalAgentRuntimePool } from "../src/local-agent-runtime-pool.js";
import { LocalAgentStore } from "../src/local-agent-store.js";
import { LocalAgentEvidenceStore } from "../src/local-agent-evidence.js";
import { LocalAgentContextPacks } from "../src/local-agent-context-pack.js";
import { CodingWorkflowStore } from "../src/coding-workflows.js";

if (process.env.SYNREX_LIVE_AGENT_SMOKE !== "1") {
  throw new Error("Explicit SYNREX_LIVE_AGENT_SMOKE=1 required.");
}
const home = mkdtempSync(join(tmpdir(), "synrex-gateway-agent-qa-"));
const workspaceRoot = join(home, "project");
const stateDir = join(home, "state");
const scope = { workspaceId: "ws_continuity_probe", workspaceRoot };
const model = process.env.ANTIGRAVITY_MODEL ?? "gemini-3.8-flash-medium";
const contextSmoke = process.env.SYNREX_LIVE_CONTEXT_SMOKE === "1";
let manager: LocalAgentManager | undefined;
try {
  mkdirSync(workspaceRoot);
  execFileSync("git", ["init", "-q", workspaceRoot]);
  writeFileSync(join(workspaceRoot, "README.md"), "Synrex isolated evidence test.\n");
  if (contextSmoke) {
    writeFileSync(join(workspaceRoot, "handoff.ts"),
      "export function recoverHandshakeExactly() { return 'healthy'; }\n");
  }
  execFileSync("git", ["-C", workspaceRoot, "add", "."]);
  execFileSync("git", ["-C", workspaceRoot, "-c", "user.email=test@example.invalid",
    "-c", "user.name=Test", "commit", "-qm", "fixture"]);

  const evidence = new LocalAgentEvidenceStore(stateDir);
  const contextPacks = new LocalAgentContextPacks(stateDir);
  let workflowId: string | undefined;
  if (contextSmoke) {
    const workflows = new CodingWorkflowStore(stateDir);
    const workflow = workflows.create(workspaceRoot, {
      title: "G4 context live smoke",
      goal: "Find the exported function in handoff.ts",
      acceptanceCriteria: ["Function name matches source"],
      constraints: ["Do not edit the repository"],
    });
    workflowId = workflow.workflowId;
    workflows.close();
  }
  const store = new LocalAgentStore(stateDir);
  manager = new LocalAgentManager({
    store, evidenceStore: evidence, contextPacks,
    drivers: [new AntigravityLocalAgentDriver({
      ...process.env,
      ANTIGRAVITY_COMMAND: process.env.ANTIGRAVITY_COMMAND ?? "/home/swy/.local/bin/agy",
      ANTIGRAVITY_MODEL: model,
    })],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [],
    allowedRoots: [workspaceRoot],
    subagents: {
      enabled: true, instructions: "on-demand",
      providers: [{ id: "antigravity", enabled: true, model }],
    },
  });
  const startedAt = performance.now();
  const start = await manager.start({
    target: "antigravity",
    prompt: contextSmoke
      ? "From the attached Synrex Context Pack, give only the exported function identifier in handoff.ts. Do not edit files."
      : "Reply exactly CONTINUITY_AGENT_OK. Do not use tools or modify files.",
    workspaceRoot, workspaceId: scope.workspaceId, writeMode: "read_only",
    ...(contextSmoke ? { context: { workflowId, files: ["handoff.ts"] } } : {}),
  });
  if (start.isErr()) throw new Error(`agent.start: ${start.error.message}`);
  let record = start.value;
  const deadline = Date.now() + 190_000;
  while (record.status === "running" || record.status === "starting") {
    if (Date.now() >= deadline) throw new Error("Agent smoke did not finish within 190 seconds.");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = manager.get(record.id, scope, { includeEvidence: true });
    if (status.isErr()) throw new Error(status.error.message);
    record = status.value;
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const providerCompleted = record.status === "idle";
  const wasCompleted = providerCompleted
    && (contextSmoke
      ? record.latestResponse?.includes("recoverHandshakeExactly")
      : record.latestResponse?.trim() === "CONTINUITY_AGENT_OK");
  console.log(JSON.stringify({
    stage: "live_agent",
    provider: record.provider, model, id: record.id,
    completed: providerCompleted, firstPassCorrect: wasCompleted,
    responsePreview: record.latestResponse?.slice(0, 220) ?? "",
    status: record.status, elapsedMs,
    evidence: {
      saved: !!record.evidenceSummary, ref: record.evidenceSummary?.ref,
      outcome: record.evidence?.outcome, itemCount: record.evidenceSummary?.itemCount,
      context: record.evidence?.context ?? null,
    },
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  }));
  if (!record.evidenceSummary || !record.evidence) throw new Error("Missing execution evidence.");
  if (record.evidence.outcome !== (providerCompleted ? "completed" : "failed")) {
    throw new Error("Evidence outcome does not match observed task state.");
  }
  await manager.close();
  manager = undefined;
  const reopened = new LocalAgentStore(stateDir);
  try {
    const afterRestart = reopened.getById(record.id);
    const prior = new LocalAgentEvidenceStore(stateDir).read(record.id, record.evidenceSummary.ref);
    console.log(JSON.stringify({
      stage: "reopen", recordRecovered: !!afterRestart,
      evidenceRecovered: prior.ref === record.evidenceSummary.ref,
      status: afterRestart?.status,
    }));
    if (!afterRestart || prior.ref !== record.evidenceSummary.ref) throw new Error("Durability failure.");
  } finally { reopened.close(); }
  if (!wasCompleted) process.exitCode = 2;
} finally {
  await manager?.close();
  rmSync(home, { recursive: true, force: true });
}
