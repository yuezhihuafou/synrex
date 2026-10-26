import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_OUTCOME_LOOP } from "./execution-outcome-loop.js";
import { codexInstructions } from "./tool-surfaces/codex.js";
import { claudeInstructions } from "./tool-surfaces/claude.js";

for (const [name, instructions] of [
  ["codex", codexInstructions()],
  ["claude", claudeInstructions({ agents: "", skills: "" })],
]) test(`${name} instructions keep the original goal as the stop condition`, () => {
  assert.ok(instructions.includes(EXECUTION_OUTCOME_LOOP));
  assert.equal(instructions.split(EXECUTION_OUTCOME_LOOP).length, 2, "include the rule exactly once");
  assert.match(instructions, /observable acceptance criteria/);
  assert.match(instructions, /If unmet, inspect the actual failure/);
  assert.match(instructions, /try|alternative/);
  assert.match(instructions, /not goal completion/);
  assert.match(instructions, /concrete external blocker/);
  assert.match(instructions, /never blindly replay uncertain side effects/i);
});
