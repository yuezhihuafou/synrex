/** Shared, advisory goal-completion rule for GPT-facing tool instructions.
 * Synrex executes commands; it does not decide whether the user's goal is met
 * or autonomously restart a ChatGPT turn.
 */
export const EXECUTION_OUTCOME_LOOP = "Complete the user's requested outcome, not merely a tool call, plan or subtest. After each result, check remaining acceptance conditions and take the next authorized action: diagnose, repair, verify or wait for a progressing task. A command exit of 0 is not proof the goal is met; an error or elapsed time is not proof it cannot be met. Never replay an uncertain side effect. When genuinely blocked or stopped, report exact unfinished conditions, evidence and resumable IDs. Do not add workflow ceremony to ordinary fixes. Synrex cannot wake GPT after its turn ends.";

/** Included only with a failed command receipt, not normal successful commands. */
export const FAILURE_CONTINUATION_HINT = "Command exited nonzero. If unexpected or the user's acceptance criteria remain unmet, inspect the error/log, apply an authorized fix or alternative, and rerun the relevant check before concluding. An intentionally expected failure may already satisfy the request.";
