import type { CodingWorkflow } from "./coding-workflows.js";

const trim = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s;

/** Short, self-contained text for reconnects. The structured record retains full evidence. */
export function workflowHandoffText(workflow: CodingWorkflow, gitMatches: boolean | null): string {
  const checkpoint = workflow.checkpoint;
  const accepted = workflow.acceptanceCriteria.slice(0, 10).map((criterion) =>
    trim(criterion, 95)).join(" | ");
  const checks = checkpoint.checks.slice(-3).map((check) => trim(check, 125)).join(" | ");
  const next = checkpoint.nextSteps.slice(0, 4).map((step) => trim(step, 120)).join(" | ");
  const blockers = checkpoint.blockers.slice(0, 3).map((blocker) => trim(blocker, 100)).join(" | ");
  return `Resume ${workflow.workflowId} rev=${workflow.revision} status=${workflow.status}. `
    + `Goal: ${trim(workflow.goal, 180)}. Acceptance: ${accepted || "none"} (NOT independently verified). `
    + `Current: ${trim(checkpoint.summary, 160)}. Next: ${next || "inspect original acceptance"}. `
    + `Blockers: ${blockers || "none reported"}. Tasks to inspect: ${checkpoint.taskIds.slice(0, 8).join(",") || "none"}. `
    + `Recent self-reported checks: ${checks || "none"}. Git checkpoint matches: ${String(gitMatches)}. `
    + "Verify live task receipts and evidence before replaying any command.";
}
