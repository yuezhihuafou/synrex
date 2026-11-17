import type { CodingWorkflow, CodingWorkflowCheckpoint } from "./coding-workflows.js";
import type { GoalContinuity } from "./goal-continuity.js";
import type { AgentEvidenceSummary } from "./local-agent-evidence.js";

export interface WorkflowAgentEvidence {
  agentId: string;
  status: "available" | "not_found" | "wrong_workspace" | "no_evidence";
  evidence?: AgentEvidenceSummary;
}

export interface CodingWorkflowHandoff {
  v: 1;
  workflowId: string;
  workspaceId: string;
  workspaceRoot: string;
  revision: number;
  status: CodingWorkflow["status"];
  observedAt: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  phase: string;
  completedSteps: string[];
  nextSteps: string[];
  blockers: string[];
  checks: string[];
  checksAreSelfReported: true;
  taskIdsToInspect: string[];
  verifiedResults?: Array<{ criterion: number; description: string }>;
  pendingOperations?: string[];
  nextExecutableAction?: string;
  agentEvidence: WorkflowAgentEvidence[];
  liveGit: Pick<CodingWorkflowCheckpoint, "gitHead" | "gitStatus">;
  checkpointGitMatchesCurrent: boolean | null;
}

/** A fresh view of one existing workflow; never an independent task state. */
export function buildCodingWorkflowHandoff(input: {
  workflow: CodingWorkflow;
  workspaceId: string;
  workspaceRoot: string;
  liveGit: Pick<CodingWorkflowCheckpoint, "gitHead" | "gitStatus">;
  agentEvidence?: WorkflowAgentEvidence[];
  continuity?: GoalContinuity;
}): CodingWorkflowHandoff {
  const { workflow, liveGit } = input;
  const checkpoint = workflow.checkpoint;
  const checkpointGitMatchesCurrent = checkpoint.gitHead && liveGit.gitHead
    ? checkpoint.gitHead === liveGit.gitHead && checkpoint.gitStatus === liveGit.gitStatus
    : null;
  return {
    v: 1,
    workflowId: workflow.workflowId,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    revision: workflow.revision,
    status: workflow.status,
    observedAt: new Date().toISOString(),
    goal: workflow.goal,
    constraints: workflow.constraints,
    acceptanceCriteria: workflow.acceptanceCriteria,
    phase: checkpoint.phase,
    completedSteps: checkpoint.completedSteps,
    nextSteps: checkpoint.nextSteps,
    blockers: checkpoint.blockers,
    checks: checkpoint.checks,
    checksAreSelfReported: true,
    taskIdsToInspect: checkpoint.taskIds,
    ...(input.continuity ? {
      verifiedResults: input.continuity.verifiedCriteria.map(criterion => ({
        criterion, description: workflow.acceptanceCriteria[criterion]!,
      })),
      pendingOperations: input.continuity.pendingOperations,
      nextExecutableAction: input.continuity.nextAction,
      taskIdsToInspect: [...new Set([...checkpoint.taskIds, ...input.continuity.pendingTaskIds])],
    } : {}),
    agentEvidence: input.agentEvidence ?? [],
    liveGit,
    checkpointGitMatchesCurrent,
  };
}
