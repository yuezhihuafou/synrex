import { execFileSync } from "node:child_process";
import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { withCodingWorkflowStore, type CodingWorkflowCheckpoint } from "./coding-workflows.js";
import { textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription } from "./tool-surfaces/types.js";

const workflowId = z.string().regex(/^wf_[a-f0-9]{24}$/);
const shortText = z.string().trim().min(1).max(4000);
const items = z.array(z.string().trim().min(1).max(2000)).max(40);

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
  workspaceId: z.string().describe(workspaceIdDescription),
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
    .describe("Stable unique request ID for safe retry of workflow creation after an MCP disconnect."),
  workflowId: workflowId.optional().describe("Resume a known workflow, including from another ChatGPT conversation."),
  title: shortText.optional().describe("Short title for a new workflow."),
  goal: shortText.optional().describe("Goal to create a new workflow; omit when resuming by workflowId."),
  acceptanceCriteria: items.optional().describe("Observable completion criteria for a new workflow."),
  constraints: items.optional().describe("Rules, non-goals, and safety constraints for a new workflow."),
};

export function registerCodingWorkflowTools(input: {
  server: McpRegistrationTarget;
  workspaces: WorkspaceRegistry;
  stateDir: string;
}): void {
  const { server, workspaces, stateDir } = input;

  server.registerTool("workflow_open", {
    title: "Open coding workflow",
    description: "Create a persistent GPT-led coding workflow from a goal and acceptance criteria, or resume it by workflowId in a later conversation. Stores intent and progress locally; does not invoke Codex/API models.",
    inputSchema: openInput,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ workspaceId, workflowId: requestedId, requestKey, title, goal, acceptanceCriteria, constraints }) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    const result = withCodingWorkflowStore(stateDir, (store) => {
      if (requestedId) {
        if (goal || title || acceptanceCriteria || constraints || requestKey) throw new Error("Resume with workflowId only; use workflow_checkpoint to update progress.");
        return store.getRequired(requestedId, workspace.root);
      }
      if (!goal || !acceptanceCriteria?.length) {
        throw new Error("New workflow requires goal and at least one acceptance criterion. Provide workflowId to resume.");
      }
      return store.create(workspace.root, {
        title: title ?? goal.slice(0, 100), goal, acceptanceCriteria, constraints: constraints ?? [], requestKey,
      });
    });
    return {
      content: [textBlock(`Workflow ${result.workflowId} (${result.status}, revision ${result.revision}). Goal: ${result.goal}. Current: ${result.checkpoint.summary}. Next: ${result.checkpoint.nextSteps.join("; ") || "inspect and plan"}.`) ],
      structuredContent: { ...result },
    };
  });

  server.registerTool("workflow_status", {
    title: "Inspect coding workflows",
    description: "List unfinished workflows belonging to this workspace, or inspect a workflow and recent checkpoints. Use after reconnecting; check saved run/task logs before relying on past GPT summaries.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      workflowId: workflowId.optional(),
      includeCompleted: z.boolean().optional().describe("Include finished history when listing; default false."),
    },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, workflowId: requestedId, includeCompleted }) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    const result = withCodingWorkflowStore(stateDir, (store) => requestedId
      ? { workflow: store.getRequired(requestedId, workspace.root), history: store.history(requestedId, workspace.root) }
      : { workflows: store.list(workspace.root, { includeCompleted, limit: 15 }) });
    // A checkpoint is historical, potentially self-reported context. Make
    // takeover show a separate, fresh read of the actual local Git state so a
    // new conversation cannot mistake a stale summary for current checkout.
    const workflow = "workflow" in result ? result.workflow : undefined;
    const handoff = workflow ? (() => {
      const liveGit = gitSnapshot(workspace.root);
      const checkpoint = workflow.checkpoint;
      return {
        workspaceRoot: workspace.root,
        observedAt: new Date().toISOString(),
        liveGit,
        checkpointGitMatchesCurrent: checkpoint.gitHead && liveGit.gitHead
          ? checkpoint.gitHead === liveGit.gitHead && checkpoint.gitStatus === liveGit.gitStatus
          : null,
        taskIdsToInspect: checkpoint.taskIds,
        checksAreSelfReported: true,
      };
    })() : undefined;
    return {
      content: [textBlock(handoff && workflow
        ? `Workflow handoff: ${workflow.workflowId} revision ${workflow.revision}. Git matches saved checkpoint: ${String(handoff.checkpointGitMatchesCurrent)}. Inspect ${handoff.taskIdsToInspect.length} referenced task receipt(s) before retrying; checkpoint checks are self-reported. Next: ${workflow.checkpoint.nextSteps.join("; ") || "none"}.`
        : JSON.stringify(result))],
      structuredContent: { ...result, ...(handoff ? { handoff } : {}) },
    };
  });

  server.registerTool("workflow_checkpoint", {
    title: "Save coding workflow checkpoint",
    description: "Persist a verified milestone, self-reported test evidence, pending durable task IDs and next steps. Use after significant coding phases and before ending an unfinished turn. expectedRevision rejects stale-conversation overwrites. Does not execute model turns.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      workflowId,
      expectedRevision: z.number().int().nonnegative(),
      status: z.enum(["active", "blocked", "completed", "cancelled"]),
      phase: shortText,
      summary: shortText,
      completedSteps: items.describe("Accumulated completed work, not just changes in this checkpoint."),
      nextSteps: items.describe("Unfinished actions; empty only if truly finished."),
      blockers: items.describe("Specific errors or missing prerequisites."),
      checks: items.describe("Actual test/check commands and observed outcomes; never assert unrun tests passed."),
      taskIds: z.array(z.string().regex(/^task_[a-zA-Z0-9-]+$/)).max(40)
        .describe("Durable shell task IDs that still need inspection or follow-up."),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ workspaceId, workflowId: id, expectedRevision, status, phase, summary, completedSteps, nextSteps, blockers, checks, taskIds }) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    if (status === "completed" && (nextSteps.length || blockers.length || taskIds.length)) {
      throw new Error("Cannot mark completed while next steps, blockers, or unverified running task IDs remain.");
    }
    const checkpoint: CodingWorkflowCheckpoint = {
      phase, summary, completedSteps, nextSteps, blockers, checks, taskIds,
      ...gitSnapshot(workspace.root),
    };
    const result = withCodingWorkflowStore(stateDir, (store) => store.checkpoint(workspace.root, {
      workflowId: id, expectedRevision, status, checkpoint,
    }));
    return {
      content: [textBlock(`Saved ${result.workflowId} revision ${result.revision}, status ${result.status}. Next: ${result.checkpoint.nextSteps.join("; ") || "none"}.`) ],
      structuredContent: { ...result },
    };
  });
}
