import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerCodingWorkflowTools } from "./coding-workflow-tools.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentEvidenceStore } from "./local-agent-evidence.js";
import type { ProjectMemoryPort, ProjectMemoryRecall, ProjectMemoryHydration } from "./project-memory-port.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { WorkspaceRegistry } from "./workspaces.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, any>;
}>;

test("real workflow tools compose a scoped handoff, historical agent evidence and optional memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-handoff-integration-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  mkdirSync(project);
  try {
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "main.ts"), "export const value = 1;\n");
    execFileSync("git", ["-C", project, "add", "main.ts"]);
    execFileSync("git", ["-C", project, "-c", "user.email=test@example.invalid",
      "-c", "user.name=Test", "commit", "-qm", "fixture"]);
    const head = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const agentStore = new LocalAgentStore(stateDir);
    const agent = agentStore.create({
      workspaceId: "ws_integration", workspaceRoot: project,
      profileName: "antigravity", provider: "antigravity",
    });
    const evidence = new LocalAgentEvidenceStore(stateDir).save({
      agentId: agent.id, provider: "antigravity", workspaceRoot: project,
      startedAt: "2026-10-24T00:00:00Z", outcome: "completed",
      response: "DONE", items: [{ type: "tool", test: true }],
    });
    agentStore.close();
    const workflows = new CodingWorkflowStore(stateDir);
    const workflow = workflows.create(project, {
      title: "Handoff integration", goal: "Recover an agent task",
      acceptanceCriteria: ["test passes"], constraints: ["do not touch production"],
    });
    const checkpoint = workflows.checkpoint(project, {
      workflowId: workflow.workflowId, expectedRevision: 0, status: "active",
      checkpoint: {
        phase: "debug", summary: "waiting on test", completedSteps: ["read code"],
        nextSteps: ["run test"], blockers: [], checks: ["not yet independently verified"],
        taskIds: ["task_test"], agentIds: [agent.id], gitHead: head, gitStatus: "",
      },
    });
    workflows.close();

    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _metadata: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpRegistrationTarget;
    const workspaces = {
      getWorkspace: async () => ({ root: project }),
    } as unknown as WorkspaceRegistry;
    let recalls = 0;
    const memory: ProjectMemoryPort = {
      async recall(): Promise<ProjectMemoryRecall> {
        recalls++;
        return { status: "ok", project: "Memhub", items: [], bytes: 0 };
      },
      async hydrate(): Promise<ProjectMemoryHydration> {
        return { status: "disabled", reason: "No hydrate in this test" };
      },
    };
    registerCodingWorkflowTools({ server, workspaces, stateDir, memory });
    const status = handlers.get("workflow_status")!;
    const base = await status({ workspaceId: "ws_integration", workflowId: workflow.workflowId });
    const handoff = base.structuredContent.handoff;
    assert.equal(handoff.v, 1);
    assert.equal(handoff.revision, 1);
    assert.equal(handoff.checkpointGitMatchesCurrent, true);
    assert.equal(handoff.checksAreSelfReported, true);
    assert.equal(handoff.agentEvidence[0].evidence.ref, evidence.ref);
    assert.equal(recalls, 0, "optional memory is never called by default");
    const withMemory = await status({
      workspaceId: "ws_integration", workflowId: workflow.workflowId,
      includeMemory: true, memoryProject: "Memhub",
    });
    assert.equal(withMemory.structuredContent.memoryContext.status, "ok");
    assert.equal(recalls, 1);
    const missingProject = await status({
      workspaceId: "ws_integration", workflowId: workflow.workflowId, includeMemory: true,
    });
    assert.equal(missingProject.structuredContent.memoryContext.status, "ambiguous");
    assert.equal(recalls, 1);

    const write = handlers.get("workflow_checkpoint")!;
    const updated = await write({
      workspaceId: "ws_integration", workflowId: workflow.workflowId,
      expectedRevision: checkpoint.revision, status: "active",
      phase: "testing", summary: "Running tests", completedSteps: ["read code"],
      nextSteps: ["run test"], blockers: [], checks: [], taskIds: [],
      // Older clients omit agentIds; the previous explicit association survives.
    });
    assert.deepEqual(updated.structuredContent.checkpoint.agentIds, [agent.id]);
    writeFileSync(join(project, "main.ts"), "export const value = 2;\n");
    const stale = await status({ workspaceId: "ws_integration", workflowId: workflow.workflowId });
    assert.equal(stale.structuredContent.handoff.checkpointGitMatchesCurrent, false);
    assert.equal(stale.structuredContent.handoff.agentEvidence[0].evidence.ref, evidence.ref);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
