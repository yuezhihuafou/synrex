/** Shared, advisory goal-completion rule for GPT-facing tool instructions.
 * Synrex executes commands; it does not decide whether the user's goal is met
 * or autonomously restart a ChatGPT turn.
 */
export const EXECUTION_OUTCOME_LOOP = "Complete the user's actual requested outcome; do not substitute a plan, successful tool call, passing subtest, checkpoint, or partial artifact. The stop condition is the original observable acceptance criteria, including integration or user-visible verification when required. On error or delay, default to the NEXT authorized action in this turn: diagnose, repair, try an alternative, run, and verify instead of writing a premature final report. A failed test leads to diagnosis and a fix, not a declaration of completion; a slow job can proceed in parallel with independent useful work. Do not spin on status checks or invent success. Do not blindly replay uncertain side effects. When facing a concrete external blocker or missing authority, report remaining criteria, evidence, and resumable task/process IDs. No extra workflow ceremony for ordinary fixes. Synrex cannot wake GPT after its turn ends.";

/** Included only with a failed command receipt, not normal successful commands. */
export const FAILURE_CONTINUATION_HINT = "Command exited nonzero. If unexpected or the user's acceptance criteria remain unmet, inspect the error/log, apply an authorized fix or alternative, and rerun the relevant check before concluding. An intentionally expected failure may already satisfy the request.";
