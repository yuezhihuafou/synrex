import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { liveWorkflowEvidence, registerCodingWorkflowTools } from "./coding-workflow-tools.js";
import { assessGoal } from "./goal-continuity.js";
import { CodingWorkflowStore } from "./coding-workflows.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentEvidenceStore } from "./local-agent-evidence.js";
import type { ProjectMemoryPort, ProjectMemoryRecall, ProjectMemoryHydration } from "./project-memory-port.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { WorkspaceRegistry } from "./workspaces.js";

type Handler = (args: Record<string, unknown>, extra?: { _meta?: Record<string, unknown> }) => Promise<{
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
      workspaceId: "ws_integration",
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
    const descriptors = new Map<string, Record<string, any>>();
    const server = {
      registerTool: (name: string, metadata: Record<string, any>, handler: Handler) => {
        handlers.set(name, handler);
        descriptors.set(name, metadata);
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
    registerCodingWorkflowTools({ server, workspaces, stateDir, memory, uiEnabled: true });
    assert.equal(descriptors.get("workflow_status")?._meta?.ui?.resourceUri, "ui://devspace/workspace-app.html");
    const resumed = await handlers.get("workflow_open")!(
      { workflowId: workflow.workflowId },
      { _meta: { "openai/session": "sample-chat-scope" } },
    );
    assert.equal(resumed.structuredContent.workspaceId, "ws_integration");
    assert.equal(resumed.structuredContent.handoff.checkpointGitMatchesCurrent, true);
    const reopenedStore = new CodingWorkflowStore(stateDir);
    assert.equal(reopenedStore.getById(workflow.workflowId)?.workspaceId, "ws_integration");
    assert.equal(reopenedStore.selected(project, "ws_integration", "sample-chat-scope")?.workflowId, workflow.workflowId);
    assert.equal(reopenedStore.selected(project, "ws_integration", "other-chat"), undefined);
    reopenedStore.close();
    // A new ChatGPT connection can discover the original workspace without
    // opening a second tree or trusting a stale model summary.
    const nextConnection = new Map<string, Handler>();
    registerCodingWorkflowTools({
      server: { registerTool: (name: string, _meta: unknown, handler: Handler) => {
        nextConnection.set(name, handler);
      } } as unknown as McpRegistrationTarget,
      workspaces, stateDir, memory,
    });
    const resumedFromNextChat = await nextConnection.get("workflow_open")!({ workflowId: workflow.workflowId });
    assert.equal(resumedFromNextChat.structuredContent.workspaceId, "ws_integration");
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

test("resume reconciles stale task and TTY handles without executing writes or creating a workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-recovery-live-"));
  const project = join(root, "project"), stateDir = join(root, "state");
  mkdirSync(project);
  try {
    const store = new CodingWorkflowStore(stateDir);
    const wf = store.create(project, {
      title: "Recover", goal: "Confirm stalled work", constraints: [],
      acceptanceCriteria: ["integration test passes"], workspaceId: "ws_recovery",
    });
    const task = store.observe(project, wf.workflowId, {
      eventKey: "run:run_dead", kind: "command", status: "running",
      runId: "run_dead", taskId: "task_dead",
    });
    store.observe(project, wf.workflowId, {
      eventKey: "run:run_tty", kind: "command", status: "running",
      runId: "run_tty", sessionId: 88,
    });
    store.checkpoint(project, { workflowId: wf.workflowId, expectedRevision: 0, status: "active",
      checkpoint: { phase: "verify", summary: "Old receipts", completedSteps: [],
        nextSteps: [], blockers: [], checks: [], taskIds: ["task_dead"] },
    });
    store.close();
    let liveReads = 0;
    const durableTasks = { available: true, async get(_root: string, id: string,
      options: { acknowledge?: boolean }) {
      assert.equal(id, "task_dead");
      assert.equal(options.acknowledge, false);
      liveReads++;
      return { status: "cancelled", taskId: id, runId: "run_dead" };
    } } as any;
    const processSessions = { status(_workspaceId: string, sessionId: number) {
      assert.equal(_workspaceId, "ws_recovery");
      assert.equal(sessionId, 88);
      return { sessionId, runId: "run_tty", running: false, exitCode: 0 };
    } } as any;
    const before = new CodingWorkflowStore(stateDir);
    const current = before.getRequired(wf.workflowId, project);
    before.close();
    const events = await liveWorkflowEvidence({
      stateDir, workflow: current, workspaceRoot: project, workspaceId: "ws_recovery",
      durableTasks, processSessions,
    });
    assert.equal(events.find(e => e.eventId === task.eventId)?.status, "cancelled");
    assert.equal(events.find(e => e.sessionId === 88)?.status, "completed");
    const goal = assessGoal(current, events);
    assert.deepEqual(goal.pendingTaskIds, []);
    assert.deepEqual(goal.pendingOperations, []);
    assert.equal(goal.status, "unknown", "unfinished acceptance cannot turn into success");
    const handlers = new Map<string, Handler>();
    registerCodingWorkflowTools({
      server: { registerTool: (name: string, _meta: unknown, handler: Handler) =>
        handlers.set(name, handler) } as unknown as McpRegistrationTarget,
      workspaces: { getWorkspace: async () => ({ root: project }) } as unknown as WorkspaceRegistry,
      stateDir, durableTasks, processSessions,
    });
    const resumed = await handlers.get("workflow_open")!({ workflowId: wf.workflowId });
    assert.equal(resumed.structuredContent.revision, 1);
    assert.deepEqual(resumed.structuredContent.continuity.pendingOperations, []);
    const view = await handlers.get("workflow_status")!({ workspaceId: "ws_recovery", workflowId: wf.workflowId });
    assert.deepEqual(view.structuredContent.continuity.pendingTaskIds, []);
    assert.equal(view.structuredContent.workflow.revision, 1, "resume is read-only to task source state");
    assert.ok(liveReads >= 3);
    const fresh = new CodingWorkflowStore(stateDir);
    assert.equal(fresh.getRequired(wf.workflowId, project).revision, 1);
    fresh.close();
    const missing = await liveWorkflowEvidence({
      stateDir, workflow: current, workspaceRoot: project, workspaceId: "ws_recovery",
      durableTasks: { available: true, async get() { throw new Error("task log unavailable"); } } as any,
    });
    assert.equal(missing.find(e => e.eventId === task.eventId)?.status, "unknown");
    assert.ok(assessGoal(current, missing).pendingOperations.length > 0,
      "missing receipts must never become an assumed success");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
