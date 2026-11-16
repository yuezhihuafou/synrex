import type { CodingWorkflow, WorkflowExecutionEvidence } from "./coding-workflows.js";

export type GoalStatus = "satisfied" | "in_progress" | "blocked" | "unknown";
export interface GoalContinuity {
  status: GoalStatus;
  remaining: string[];
  verifiedCriteria: number[];
  pendingTaskIds: string[];
  nextAction: string;
  evidenceBased: true;
}

/** Observed passing verification is evidence; self-reported checks are only notes. */
export function assessGoal(workflow: CodingWorkflow, events: readonly WorkflowExecutionEvidence[]): GoalContinuity {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const verifiedCriteria = [...new Set((workflow.checkpoint.criterionEvidence ?? [])
    .filter((claim) => Number.isInteger(claim.criterion) && claim.criterion >= 0
      && claim.criterion < workflow.acceptanceCriteria.length
      && byId.get(claim.eventId)?.kind === "verification"
      && byId.get(claim.eventId)?.status === "completed"
      && byId.get(claim.eventId)?.exitCode === 0)
    .map((claim) => claim.criterion))].sort((a, b) => a - b);
  const remaining = workflow.acceptanceCriteria.filter((_, index) => !verifiedCriteria.includes(index));
  const pendingTaskIds = [...new Set([
    ...workflow.checkpoint.taskIds,
    ...events.filter((event) => event.status === "working" && event.taskId)
      .map((event) => event.taskId!),
  ])].slice(0, 40);
  const blocked = workflow.status === "blocked" || workflow.checkpoint.blockers.length > 0;
  const satisfied = workflow.status !== "cancelled" && !blocked
    && remaining.length === 0 && verifiedCriteria.length > 0
    && pendingTaskIds.length === 0 && workflow.checkpoint.nextSteps.length === 0;
  const status: GoalStatus = satisfied ? "satisfied" : blocked ? "blocked"
    : workflow.checkpoint.nextSteps.length > 0 || pendingTaskIds.length > 0
      ? "in_progress" : "unknown";
  return {
    status, remaining, verifiedCriteria, pendingTaskIds, evidenceBased: true,
    nextAction: satisfied ? "finish_with_verified_evidence"
      : blocked ? "report_or_resolve_blocker"
        : pendingTaskIds.length > 0 ? "inspect_pending_task"
          : workflow.checkpoint.nextSteps.length > 0 ? "continue_next_step"
            : "verify_remaining_acceptance",
  };
}

export function continuityHint(workflow: CodingWorkflow, goal: GoalContinuity): string {
  const next = workflow.checkpoint.nextSteps[0] ?? goal.remaining[0] ?? "review original goal";
  return "Workflow " + workflow.workflowId + " goal=" + goal.status
    + " (not command exit); next=" + next.slice(0, 140)
    + ". Verify original acceptance before reporting completion.";
}
