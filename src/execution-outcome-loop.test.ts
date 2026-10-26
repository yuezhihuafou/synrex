import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_OUTCOME_LOOP, FAILURE_CONTINUATION_HINT } from "./execution-outcome-loop.js";
import { codexInstructions } from "./tool-surfaces/codex.js";
import { claudeInstructions } from "./tool-surfaces/claude.js";

for (const [name, instructions] of [
  ["codex", codexInstructions()],
  ["claude", claudeInstructions({ agents: "", skills: "" })],
]) test(`${name} instructions keep the original goal as the stop condition`, () => {
  assert.ok(instructions.includes(EXECUTION_OUTCOME_LOOP));
  assert.equal(instructions.split(EXECUTION_OUTCOME_LOOP).length, 2, "include the rule exactly once");
  assert.match(instructions, /observable acceptance criteria/);
  assert.match(instructions, /the NEXT authorized action/);
  assert.match(instructions, /do not substitute a plan/);
  assert.match(instructions, /try|alternative/);
  assert.match(instructions, /stop condition is the original observable acceptance criteria/);
  assert.match(instructions, /concrete external blocker/);
  assert.match(instructions, /Do not blindly replay uncertain side effects/i);
});

test("a failed command prompts recovery, not an excuse to finish", () => {
  assert.match(FAILURE_CONTINUATION_HINT, /goal is still open/);
  assert.match(FAILURE_CONTINUATION_HINT, /fix or alternative/);
  assert.match(FAILURE_CONTINUATION_HINT, /Do not stop at diagnosis/);
});
