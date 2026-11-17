import { execFileSync } from "node:child_process";
import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { withCodingWorkflowStore, type CodingWorkflowCheckpoint, type CodingWorkflow, type WorkflowExecutionEvidence } from "./coding-workflows.js";
import type { DurableTaskManager } from "./durable-tasks.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import { LearningStore } from "./learning-store.js";
import { buildCodingWorkflowHandoff, type WorkflowAgentEvidence } from "./coding-workflow-handoff.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentEvidenceStore } from "./local-agent-evidence.js";
import type { ProjectMemoryPort } from "./project-memory-port.js";
import { DisabledProjectMemoryPort } from "./project-memory-port.js";
import { textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";
import { workflowHandoffText } from "./workflow-handoff.js";
import { withWorkspaceLifecycleLock } from "./workspace-lifecycle-lock.js";
import { assessGoal, continuityHint } from "./goal-continuity.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { WORKSPACE_APP_URI } from "./tool-surfaces/types.js";

const workflowId = z.string().regex(/^wf_[a-f0-9]{24}$/);
const shortText = z.string().trim().min(1).max(4000);
const items = z.array(z.string().trim().min(1).max(2000)).max(40);

/** Reconcile only when a user explicitly opens/inspects a workflow, never
 * during ordinary command execution. Historical receipts remain immutable;
 * returned live evidence takes precedence without replaying a command.
 */
export async function liveWorkflowEvidence(input: {
  stateDir: string;
  workflow: CodingWorkflow;
  workspaceRoot: string;
  workspaceId: string;
  durableTasks?: Pick<DurableTaskManager, "get" | "available">;
  processSessions?: Pick<ProcessSessionManager, "status">;
}): Promise<WorkflowExecutionEvidence[]> {
  const records = withCodingWorkflowStore(input.stateDir, store =>
    store.evidence(input.workflow.workflowId, input.workspaceRoot));
  const unresolved = records.filter(e =>
    ["working", "running", "input_required", "unknown"].includes(e.status) &&
    ((e.taskId && input.durableTasks?.available) ||
      (e.sessionId !== undefined && input.processSessions)));
  const latest = unresolved.slice(0, 32);
  if (latest.length === 0) return records;
  const statuses = await Promise.all(latest.map(async evidence => {
    try {
      if (evidence.taskId && input.durableTasks?.available) {
        const view = await input.durableTasks.get(input.workspaceRoot, evidence.taskId,
          { acknowledge: false });
        if (evidence.runId && view.runId !== evidence.runId) throw new Error("Task handle run mismatch");
        const status: WorkflowExecutionEvidence["status"] =
          view.status === "working" ? "running"
            : view.status === "input_required" ? "input_required"
              : view.status === "cancelled" ? "cancelled"
                : view.status === "completed" && view.result?.exitCode === 0 && !view.result?.isError
                  ? "completed" : view.status === "failed" || view.status === "completed"
                    ? "failed" : "unknown";
        return { ...evidence, status, exitCode: view.result?.exitCode ?? undefined };
      }
      if (evidence.sessionId !== undefined && input.processSessions) {
        const view = input.processSessions.status(input.workspaceId, evidence.sessionId);
        if (evidence.runId && view.runId !== evidence.runId) throw new Error("Process session run mismatch");
        return { ...evidence, status: view.running ? "running" as const
          : view.exitCode === 0 ? "completed" as const
            : view.exitCode !== undefined || view.signal ? "failed" as const : "unknown" as const,
          exitCode: view.exitCode };
      }
    } catch { // Missing/expired receipts cannot be promoted to success.
      return { ...evidence, status: "unknown" as const };
    }
    return evidence;
  }));
  const updates = new Map(statuses.map(e => [e.eventId, e]));
  return records.map(e => updates.get(e.eventId) ?? e);
}

function gitSnapshot(root: string): Pick<CodingWorkflowCheckpoint, "gitHead" | "gitStatus"> {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 3000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  try {
    const gitHead = git("rev-parse", "--verify", "HEAD");
    const status = git("status", "--porcelain=v1", "--untracked-files=normal");
    return { gitHead, gitStatus: status.slice(0, 12000) };
  } catch {
    // Non-Git workspaces can still use durable coding workflows.
    return {};
  }
}

const openInput = {
  workspaceId: z.string().optional().describe("Required to create; omit when resuming by workflowId."),
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
    .describe("Idempotency key for workflow creation retries."),
  workflowId: workflowId.optional().describe("Resume an existing workflow."),
  title: shortText.optional().describe("Short title for a new workflow."),
  goal: shortText.optional().describe("Goal for a new workflow."),
  acceptanceCriteria: items.optional().describe("Observable completion criteria."),
  constraints: items.optional().describe("Constraints and non-goals."),
  leaseAction: z.enum(["acquire", "renew", "release"]).optional(),
  leaseId: z.string().regex(/^wl_[a-f0-9]{32}$/).optional(),
};

export function registerCodingWorkflowTools(input: {
  server: McpRegistrationTarget;
  workspaces: WorkspaceRegistry;
  stateDir: string;
  durableTasks?: Pick<DurableTaskManager, "get" | "available">;
  processSessions?: Pick<ProcessSessionManager, "status">;
  memory?: ProjectMemoryPort;
  uiEnabled?: boolean;
}): void {
  const { server, workspaces, stateDir } = input;
  const memory = input.memory ?? new DisabledProjectMemoryPort();
  const uiMeta = input.uiEnabled ? { _meta: {
    ui: { resourceUri: WORKSPACE_APP_URI, visibility: ["model"] },
  } } : {};

  server.registerTool("workflow_open", {
    title: "Open coding workflow",
    description: "Create or resume a workflow. Resume by workflowId alone across chats; optional leaseAction protects active worktrees.",
    inputSchema: openInput,
    ...uiMeta,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ workspaceId, workflowId: requestedId, requestKey, title, goal, acceptanceCriteria, constraints, leaseAction, leaseId }, extra) => {
    if (leaseAction) {
      if (!workspaceId || requestedId || goal || title || acceptanceCriteria || constraints || requestKey) {
        throw new Error("Lease operation requires workspaceId and leaseAction only (plus leaseId for renew/release)");
      }
      const result = await withWorkspaceLifecycleLock(stateDir, async () => {
        await workspaces.getWorkspace(workspaceId);
        return withCodingWorkflowStore(stateDir, store => {
          if (leaseAction === "acquire") {
            if (leaseId) throw new Error("Omit leaseId when acquiring");
            return { action: leaseAction, ...store.lease(workspaceId) };
          }
          if (!leaseId) throw new Error("Renew/release requires leaseId");
          if (leaseAction === "renew") return { action: leaseAction, ...store.lease(workspaceId, leaseId) };
          return { action: leaseAction, released: store.releaseLease(workspaceId, leaseId) };
        });
      });
      return { content: [textBlock(JSON.stringify(result))], structuredContent: result };
    }
    const result = await withWorkspaceLifecycleLock(stateDir, async () => {
      let id = workspaceId;
      if (requestedId) {
        const existing = withCodingWorkflowStore(stateDir, store => store.getById(requestedId));
        if (!existing) throw new Error("Unknown workflow ID");
        if (existing.workspaceId) {
          if (id && id !== existing.workspaceId) {
            const requested = await workspaces.getWorkspace(id);
            const owner = await workspaces.getWorkspace(existing.workspaceId);
            if ((requested.sourceRoot ?? requested.root) !== (owner.sourceRoot ?? owner.root)) {
              throw new Error("Workflow belongs to a different project");
            }
          }
          id = existing.workspaceId;
        } else if (!id) {
          throw new Error("Legacy workflow has no workspace session. Reopen its original workspace.");
        }
      }
      if (!id) throw new Error("Creating a workflow requires workspaceId");
      const workspace = await workspaces.getWorkspace(id);
      const record = withCodingWorkflowStore(stateDir, store => {
        if (requestedId) {
          if (goal || title || acceptanceCriteria || constraints || requestKey) throw new Error("Resume with workflowId only");
          return store.getRequired(requestedId, workspace.root);
        }
        if (!goal || !acceptanceCriteria?.length) throw new Error("New workflow requires goal and acceptanceCriteria");
        return store.create(workspace.root, {
          title: title ?? goal.slice(0, 100), goal, acceptanceCriteria, constraints: constraints ?? [],
          requestKey, workspaceId: id,
        });
      });
      if (record.workspaceId && record.workspaceId !== id) throw new Error("Workflow workspace session mismatch");
      return { record, id, root: workspace.root };
    });
    const continuity = assessGoal(result.record, await liveWorkflowEvidence({
      stateDir, workflow: result.record, workspaceRoot: result.root, workspaceId: result.id,
      durableTasks: input.durableTasks, processSessions: input.processSessions,
    }));
    const handoff = requestedId ? buildCodingWorkflowHandoff({
      workflow: result.record, workspaceId: result.id, workspaceRoot: result.root,
      liveGit: gitSnapshot(result.root), agentEvidence: [], continuity,
    }) : undefined;
    const scope = conversationScopeIdFromRequestMeta(extra?._meta);
    if (scope && result.record.status !== "completed" && result.record.status !== "cancelled") {
      withCodingWorkflowStore(stateDir, store => store.bind(result.record.workflowId, result.root, result.id, scope));
    }
    return {
      content: [textBlock(workflowHandoffText(result.record, handoff?.checkpointGitMatchesCurrent ?? null, continuity)
        + "\n" + continuityHint(result.record, continuity))],
      structuredContent: {
        ...result.record, workspaceId: result.id, continuity,
        ...(handoff ? { handoff } : {}),
      },
    };
  });

  server.registerTool("workflow_status", {
    title: "Inspect coding workflows",
    description: "Inspect workflows and checkpoints. Verify Git and task receipts after reconnect.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      workflowId: workflowId.optional(),
      includeCompleted: z.boolean().optional().describe("Include completed history; default false."),
      includeMemory: z.boolean().optional().describe("Optional bounded read-only MemHub recall."),
      memoryProject: z.string().trim().min(1).max(128).optional().describe("Explicit MemHub project slug."),
    },
    ...uiMeta,
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, workflowId: requestedId, includeCompleted, includeMemory, memoryProject }) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    const result = withCodingWorkflowStore(stateDir, (store) => requestedId
      ? { workflow: store.getRequired(requestedId, workspace.root), history: store.history(requestedId, workspace.root) }
      : { workflows: store.list(workspace.root, { includeCompleted, limit: 15 }) });
    // A checkpoint is historical, potentially self-reported context. Make
    // takeover show a separate, fresh read of the actual local Git state so a
    // new conversation cannot mistake a stale summary for current checkout.
    const workflow = "workflow" in result ? result.workflow : undefined;
    const goal = workflow ? assessGoal(workflow, await liveWorkflowEvidence({
      stateDir, workflow, workspaceRoot: workspace.root, workspaceId,
      durableTasks: input.durableTasks, processSessions: input.processSessions,
    })) : undefined;
    const handoff = workflow ? (() => {
      const liveGit = gitSnapshot(workspace.root);
      const checkpoint = workflow.checkpoint;
      const agentEvidence: WorkflowAgentEvidence[] = [];
      if (checkpoint.agentIds?.length) {
        const agentStore = new LocalAgentStore(stateDir);
        const artifacts = new LocalAgentEvidenceStore(stateDir);
        try {
          for (const agentId of checkpoint.agentIds.slice(0, 20)) {
            const agent = agentStore.getById(agentId);
            if (!agent) { agentEvidence.push({ agentId, status: "not_found" }); continue; }
            if (agent.workspaceRoot !== workspace.root ||
                (agent.workspaceId && agent.workspaceId !== workspaceId)) {
              agentEvidence.push({ agentId, status: "wrong_workspace" });
              continue;
            }
            try {
              const evidence = artifacts.latest(agentId);
              agentEvidence.push(evidence
                ? { agentId, status: "available", evidence }
                : { agentId, status: "no_evidence" });
            } catch { agentEvidence.push({ agentId, status: "no_evidence" }); }
          }
        } finally { agentStore.close(); }
      }
      return buildCodingWorkflowHandoff({
        workflow, workspaceId, workspaceRoot: workspace.root, liveGit, agentEvidence, continuity: goal,
      });
    })() : undefined;
    const memoryContext = requestedId && includeMemory
      ? memoryProject
        ? await memory.recall({
          project: memoryProject,
          query: workflow ? `${workflow.goal}\n${workflow.checkpoint.nextSteps.join("; ")}` : "",
          maxBytes: 8_000,
        }).catch(() => ({
          status: "unavailable" as const,
          reason: "Optional memory adapter failed; workflow state is still valid.",
        }))
        : { status: "ambiguous" as const, reason: "Explicit memoryProject required." }
      : undefined;
    return {
      content: [textBlock(handoff && workflow
        ? workflowHandoffText(workflow, handoff.checkpointGitMatchesCurrent, goal)
          + (goal ? "\n" + continuityHint(workflow, goal) : "")
        : ("workflows" in result ? result.workflows?.map(w=>`${w.workflowId} ${w.status} rev=${w.revision}: ${w.goal.slice(0, 100)}; next=${(w.checkpoint.nextSteps[0]??"inspect original goal").slice(0, 100)}; tasks=${w.checkpoint.taskIds.slice(0,3).join(",")}`).join("\n") || "No unfinished workflows." : JSON.stringify(result)))],
      structuredContent: {
        ...result,
        ...(handoff ? { handoff } : {}),
        ...(memoryContext ? { memoryContext } : {}),
        ...(goal ? { continuity: goal } : {}),
      },
    };
  });

  server.registerTool("workflow_checkpoint", {
    title: "Save coding workflow checkpoint",
    description: "Save workflow progress and checks. Complete only after acceptance passes with no pending work. Checks are self-reported; expectedRevision guards stale writes.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      workflowId,
      expectedRevision: z.number().int().nonnegative(),
      status: z.enum(["active", "blocked", "completed", "cancelled"]),
      phase: shortText,
      summary: shortText,
      completedSteps: items.describe("Cumulative completed work."),
      nextSteps: items.describe("Remaining actions; empty only when finished."),
      blockers: items.describe("Specific errors or missing prerequisites."),
      checks: items.describe("Observed checks; never claim unrun tests passed."),
      taskIds: z.array(z.string().regex(/^task_[a-zA-Z0-9-]+$/)).max(40)
        .describe("Durable task IDs requiring follow-up."),
      agentIds: z.array(z.string().regex(/^agt_[a-f0-9]{8}$/)).max(20).optional()
        .describe("Referenced Subagent evidence IDs."),
      criterionEvidence: z.array(z.object({
        criterion: z.number().int().nonnegative(),
        eventId: z.string().regex(/^we_[a-f0-9]{24}$/),
      })).max(40).optional().describe("Map acceptance criterion indexes to observed verification event IDs."),
    },
    ...uiMeta,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ workspaceId, workflowId: id, expectedRevision, status, phase, summary, completedSteps, nextSteps, blockers, checks, taskIds, agentIds, criterionEvidence }) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    if (status === "completed" && (nextSteps.length || blockers.length || taskIds.length)) {
      throw new Error("Cannot mark completed while next steps, blockers, or unverified running task IDs remain.");
    }
    const previousAgentIds = agentIds === undefined
      ? withCodingWorkflowStore(stateDir, (store) =>
        store.getRequired(id, workspace.root).checkpoint.agentIds)
      : undefined;
    const previousCriterionEvidence = criterionEvidence === undefined
      ? withCodingWorkflowStore(stateDir, store =>
        store.getRequired(id, workspace.root).checkpoint.criterionEvidence)
      : undefined;
    const checkpoint: CodingWorkflowCheckpoint = {
      phase, summary, completedSteps, nextSteps, blockers, checks, taskIds,
      ...((agentIds ?? previousAgentIds) ? { agentIds: agentIds ?? previousAgentIds } : {}),
      ...((criterionEvidence ?? previousCriterionEvidence)
        ? { criterionEvidence: criterionEvidence ?? previousCriterionEvidence } : {}),
      ...gitSnapshot(workspace.root),
    };
    const result = await withWorkspaceLifecycleLock(stateDir, async () =>
      withCodingWorkflowStore(stateDir, (store) => store.checkpoint(workspace.root, {
        workflowId: id, expectedRevision, status, checkpoint,
      })));
    // Learning is best-effort and observational. A checkpoint is self-reported
    // context, not an independent test receipt or a verified Skill.
    try {
      new LearningStore(stateDir).recordNote({
        workspaceRoot: workspace.root,
        taskKey: `workflow:${result.workflowId}`,
        source: "workflow",
        title: result.title,
        outcome: result.status,
        summary: result.checkpoint.summary,
        resolution: result.checkpoint.completedSteps,
        checks: result.checkpoint.checks,
        nextSteps: [...result.checkpoint.nextSteps, ...result.checkpoint.blockers],
      });
    } catch {
      // Never fail an already-persisted workflow checkpoint because an
      // optional retrospective index could not be updated.
    }
    const goal = withCodingWorkflowStore(stateDir, store =>
      assessGoal(result, store.evidence(result.workflowId, workspace.root)));
    return {
      content: [textBlock(`Saved ${result.workflowId} revision ${result.revision}, status ${result.status}. Next: ${result.checkpoint.nextSteps.join("; ") || "none"}.`
        + "\n" + continuityHint(result, goal))],
      structuredContent: { ...result, continuity: goal },
    };
  });
}
