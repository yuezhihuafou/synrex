import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { LocalAgentContextPacks } from "./local-agent-context-pack.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentEvidenceStore } from "./local-agent-evidence.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRuntime } from "./local-agent-runtime.js";
import { decodeLocalAgentDaemonRequest } from "./local-agent-daemon-protocol.js";
import { parseLocalAgentRunArgs, parseLocalAgentContinueArgs } from "./local-agent-targets.js";

test("G4 context crosses daemon protocol into one Subagent and is reusable by ref", async () => {
  const home = mkdtempSync(join(tmpdir(), "synrex-context-manager-"));
  const workspaceRoot = join(home, "repo");
  const stateDir = join(home, "state");
  const scope = { workspaceId: "ws_context", workspaceRoot };
  const prompts: string[] = [];
  let manager: LocalAgentManager | undefined;
  try {
    mkdirSync(workspaceRoot);
    execFileSync("git", ["init", "-q", workspaceRoot]);
    writeFileSync(join(workspaceRoot, "handoff.ts"),
      "export function recoverPendingTasks() { return 'pending'; }\n");
    execFileSync("git", ["-C", workspaceRoot, "add", "handoff.ts"]);
    execFileSync("git", ["-C", workspaceRoot, "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);

    const workflowStore = new CodingWorkflowStore(stateDir);
    const workflow = workflowStore.create(workspaceRoot, {
      title: "Recover", goal: "Repair recoverPendingTasks",
      acceptanceCriteria: ["Recovery test passes"],
      constraints: ["No production edits"],
    });
    workflowStore.close();

    const driver: LocalAgentDriver = {
      provider: "antigravity",
      runtimeKey: () => "context-fake",
      createRuntime: async () => Result.ok({
        provider: "antigravity",
        async run(input: LocalAgentRunInput) {
          prompts.push(input.prompt);
          return Result.ok({
            provider: "antigravity" as const, providerSessionId: null,
            finalResponse: "FAKE_OK", items: [],
          });
        },
        isAlive: () => true,
        releaseSession: async () => {},
        close: async () => {},
      } satisfies LocalAgentRuntime),
    };
    const contextPacks = new LocalAgentContextPacks(stateDir);
    manager = new LocalAgentManager({
      store: new LocalAgentStore(stateDir),
      evidenceStore: new LocalAgentEvidenceStore(stateDir),
      contextPacks,
      drivers: [driver],
      pool: new LocalAgentRuntimePool(),
      loadProfiles: async () => [],
      allowedRoots: [workspaceRoot],
      subagents: {
        enabled: true, instructions: "on-demand",
        providers: [{ id: "antigravity", enabled: true, model: "gemini-context-test" }],
      },
    });
    const context = { workflowId: workflow.workflowId, files: ["handoff.ts"] };
    const parsed = parseLocalAgentRunArgs([
      "antigravity", "--workflow", workflow.workflowId, "--context-file", "handoff.ts",
      "--model", "gemini-context-test", "Fix recoverPendingTasks",
    ]);
    assert.deepEqual(parsed.context, context);
    assert.equal(parseLocalAgentContinueArgs([
      "agt_12345678", "--context-ref", "ctx_" + "a".repeat(64), "Continue",
    ]).context?.contextRef, "ctx_" + "a".repeat(64));
    const decoded = decodeLocalAgentDaemonRequest({
      requestId: "r1", protocolVersion: 3, authToken: "test", method: "agent.start",
      params: {
        target: "antigravity", prompt: parsed.prompt,
        workspaceId: scope.workspaceId, workspaceRoot, context: parsed.context,
      },
    });
    assert.equal(decoded.method, "agent.start");
    if (decoded.method !== "agent.start") return;
    assert.equal(decoded.params.context?.workflowId, workflow.workflowId);
    assert.throws(() => decodeLocalAgentDaemonRequest({
      requestId: "r2", protocolVersion: 3, authToken: "test", method: "agent.start",
      params: {
        target: "antigravity", prompt: "x", workspaceRoot,
        context: { files: ["/bad"], unknownKey: "no" },
      },
    }));

    const startAndWait = async (requestedContext?: typeof context | { contextRef: string }) => {
      const started = await manager!.start({
        target: "antigravity", prompt: "Fix recoverPendingTasks",
        ...scope, ...(requestedContext ? { context: requestedContext } : {}),
      });
      assert.equal(started.isErr(), false);
      if (started.isErr()) throw started.error;
      let status = started.value;
      const deadline = Date.now() + 2_000;
      while (status.status === "starting" || status.status === "running") {
        if (Date.now() > deadline) throw new Error("Local fake Subagent did not finish.");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = manager!.get(status.id, scope, { includeEvidence: true });
        if (result.isErr()) throw result.error;
        status = result.value;
      }
      return status;
    };
    const plain = await startAndWait();
    assert.equal(plain.status, "idle");
    assert.ok(!prompts[0]?.includes("Synrex Context Pack"));
    const first = await startAndWait(context);
    assert.equal(first.status, "idle");
    assert.match(prompts[1]!, /Synrex Context Pack/);
    assert.match(prompts[1]!, /No production edits/);
    assert.match(prompts[1]!, /handoff.ts/);
    const ref = first.evidence?.context?.ref;
    assert.match(ref ?? "", /^ctx_[a-f0-9]{64}$/);
    assert.equal(first.evidence?.context?.filesRead, 1);
    const second = await startAndWait(context);
    assert.equal(second.evidence?.context?.ref, ref);
    assert.equal(second.evidence?.context?.filesRead, 0);
    assert.equal(second.evidence?.context?.packReused, true);
    const byRef = await startAndWait({ contextRef: ref! });
    assert.equal(byRef.status, "idle");
    assert.equal(byRef.evidence?.context?.filesRead, 0);
    assert.equal(byRef.evidence?.context?.ref, ref);

    writeFileSync(join(workspaceRoot, "handoff.ts"),
      "export function recoverPendingTasks() { return 'fixed'; }\n");
    const stale = await startAndWait({ contextRef: ref! });
    assert.equal(stale.status, "error");
    assert.equal(stale.errorCode, "CONTEXT_PREPARATION_FAILED");
    assert.equal(stale.evidence?.outcome, "failed");
    assert.equal(prompts.length, 4, "stale Context Pack must not be used to run a provider");
  } finally {
    await manager?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
