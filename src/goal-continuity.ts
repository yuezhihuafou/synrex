import type { CodingWorkflow, WorkflowExecutionEvidence } from "./coding-workflows.js";

export type GoalStatus = "satisfied" | "in_progress" | "blocked" | "unknown";
export interface GoalContinuity {
  status: GoalStatus;
  remaining: string[];
  verifiedCriteria: number[];
  pendingTaskIds: string[];
  pendingOperations: string[];
  criterionStates: Array<"verified" | "unverified" | "requires_confirmation">;
  nextAction: string;
  evidenceBased: true;
}

/** Only a verification whose observed command specifically covers the criterion can prove it.
 * General functionality, deployments and human-facing UX require independent confirmation.
 */
function criterionCheck(criterion: string, command: string): "match" | "mismatch" | "manual" {
  const value = criterion.toLowerCase();
  const kinds = [
    { kind: "typecheck", criterion: /type.?check|类型检查|类型校验|tsc/, command: /typecheck|tsc/ },
    { kind: "lint", criterion: /\blint\b|静态检查|代码规范/, command: /\blint\b|eslint/ },
    { kind: "build", criterion: /\bbuild\b|编译|构建/, command: /\bbuild\b|\bcheck\b/ },
    { kind: "test", criterion: /\btests?\b|测试|用例/, command: /\btest\b|pytest|cargo test|go test|tsx --test/ },
  ];
  const requested = kinds.filter(x => x.criterion.test(value));
  if (requested.length !== 1) return "manual";
  if (!requested[0]!.command.test(command.toLowerCase())) return "mismatch";
  // A named test or file must appear in the executed command, not be guessed
  // from a successful generic suite. Vague 'tests pass' allows a suite run.
  const paths = value.match(/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?|[\w./-]+\.py/g) ?? [];
  if (paths.length && !paths.every(path => command.toLowerCase().includes(path))) return "mismatch";
  const name = value.match(/\b([\w-]+)\s+(?:test|tests)\b/);
  if (name && !["all", "the", "relevant", "passing", "automated"].includes(name[1]!)) {
    if (!command.toLowerCase().includes(name[1]!)) return "mismatch";
  }
  return "match";
}

/** Observed passing verification is evidence; self-reported checks are only notes. */
export function assessGoal(workflow: CodingWorkflow, events: readonly WorkflowExecutionEvidence[]): GoalContinuity {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const usedEvents = new Set<string>();
  const verifiedCriteria: number[] = [];
  for (const claim of workflow.checkpoint.criterionEvidence ?? []) {
    const event = byId.get(claim.eventId);
    if (!Number.isInteger(claim.criterion) || claim.criterion < 0
      || claim.criterion >= workflow.acceptanceCriteria.length
      || verifiedCriteria.includes(claim.criterion) || usedEvents.has(claim.eventId)
      || event?.kind !== "verification" || event.status !== "completed"
      || event.exitCode !== 0 || event.source !== "exec_command"
      || !event.command || !event.fingerprint || event.stale !== false
      || criterionCheck(workflow.acceptanceCriteria[claim.criterion]!, event.command) !== "match") continue;
    verifiedCriteria.push(claim.criterion);
    usedEvents.add(claim.eventId);
  }
  verifiedCriteria.sort((a, b) => a - b);
  const criterionStates = workflow.acceptanceCriteria.map((criterion, i) => verifiedCriteria.includes(i)
    ? "verified" as const : criterionCheck(criterion, "") === "manual"
      ? "requires_confirmation" as const : "unverified" as const);
  const remaining = workflow.acceptanceCriteria.filter((_, index) => !verifiedCriteria.includes(index));
  const terminalTaskIds = new Set(events.filter(event =>
    ["completed", "failed", "cancelled"].includes(event.status) && event.taskId)
    .map(event => event.taskId!));
  const pendingTaskIds = [...new Set([
    ...workflow.checkpoint.taskIds.filter(id => !terminalTaskIds.has(id)),
    ...events.filter((event) => ["working", "running", "input_required", "unknown"].includes(event.status) && event.taskId)
      .map((event) => event.taskId!),
  ])].slice(0, 40);
  const pendingOperations = [...new Set(events
    .filter((event) => ["working", "running", "input_required", "unknown"].includes(event.status))
    .map((event) => event.taskId ?? (event.sessionId !== undefined ? `session:${event.sessionId}` : undefined)
      ?? event.runId ?? event.eventId))].slice(0, 40);
  const blocked = workflow.status === "blocked" || workflow.checkpoint.blockers.length > 0;
  const satisfied = workflow.status !== "cancelled" && !blocked
    && remaining.length === 0 && verifiedCriteria.length > 0
    && pendingOperations.length === 0 && pendingTaskIds.length === 0 && workflow.checkpoint.nextSteps.length === 0;
  const status: GoalStatus = satisfied ? "satisfied" : blocked ? "blocked"
    : workflow.checkpoint.nextSteps.length > 0 || pendingOperations.length > 0 || pendingTaskIds.length > 0
      ? "in_progress" : "unknown";
  return {
    status, remaining, verifiedCriteria, pendingTaskIds, pendingOperations, criterionStates, evidenceBased: true,
    nextAction: satisfied ? "finish_with_verified_evidence"
      : blocked ? "report_or_resolve_blocker"
        : pendingOperations.length > 0 ? "inspect_pending_task"
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
