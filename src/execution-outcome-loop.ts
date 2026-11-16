/** Shared, advisory goal-completion rule for GPT-facing tool instructions.
 * Synrex executes commands; it does not decide whether the user's goal is met
 * or autonomously restart a ChatGPT turn.
 */
export const EXECUTION_OUTCOME_LOOP = "Complete the user's actual requested outcome; do not substitute a plan, subtest, or partial artifact. The stop condition is the original observable acceptance criteria, not a tool exit or intermediate step. On error or delay, default to the NEXT authorized action: diagnose, repair or try an alternative, then verify within this turn. An error or slow job does not itself complete the task. Do not blindly replay uncertain side effects. When facing a concrete external blocker or missing authority, report exact unfinished criteria, evidence and resumable task IDs. No extra workflow ceremony for ordinary fixes. Synrex cannot wake GPT after its turn ends.";

/** Included only with a failed command receipt, not normal successful commands. */
export const FAILURE_CONTINUATION_HINT = "Command exited nonzero. If unexpected or the user's acceptance criteria remain unmet, inspect the error/log, apply an authorized fix or alternative, and rerun the relevant check before concluding. An intentionally expected failure may already satisfy the request.";
