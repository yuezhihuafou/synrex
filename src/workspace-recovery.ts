import type { CodingWorkflow } from "./coding-workflows.js";

const clip = (value: string, size: number) => value.length <= size ? value : value.slice(0, size - 1) + "…";

/** Do not guess which other conversation's workflow is the active user request. */
export function workspaceRecoveryHint(workflows: CodingWorkflow[]): string {
  const lead = "Resume the current user's ORIGINAL request, not the last tool/agent milestone. On recoverable failures take the next authorized fix and verify before concluding. Re-read AGENTS.md if no longer in context.";
  if (workflows.length === 0) return lead + " No persisted workflow is linked to this request; do not invent a goal.";
  const candidates = workflows.slice(0, 3).map(w => {
    const unfinished = w.checkpoint.nextSteps[0] ?? w.checkpoint.blockers[0] ?? "inspect original acceptance";
    return `${w.workflowId} [${w.status}] goal=${clip(w.goal, 145)}; acceptance(unverified)=${clip(w.acceptanceCriteria.slice(0, 2).join(" | "), 125)}; next=${clip(unfinished, 90)}; tasks=${w.checkpoint.taskIds.slice(0, 2).join(",") || "none"}`;
  });
  return lead + ` Saved unfinished workflows (candidate context only; ${workflows.length} records, choose by user's current request): `
    + candidates.join(" ; ");
}
