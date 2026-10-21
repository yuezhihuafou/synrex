import assert from "node:assert/strict";
import test from "node:test";
import { verificationPlan } from "./verification-plan.js";

test("focused runs exactly selected tests without deleting full verification", () => {
  const plan = verificationPlan(["focused", "src/batch-read.test.ts", "src/multinode/mcp-routing.test.ts"]);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.[0]?.args.slice(-2), ["src/batch-read.test.ts", "src/multinode/mcp-routing.test.ts"]);
  assert.throws(() => verificationPlan(["focused", "../hidden.test.ts"]), /Invalid focused/);
  assert.throws(() => verificationPlan(["focused"]), /requires/);
});

test("final runs architecture and typecheck concurrently, then full tests, then optional build", () => {
  const plan = verificationPlan(["final", "--build"]);
  assert.deepEqual(plan.map((stage) => stage.map((item) => item.label)), [
    ["typecheck", "architecture"], ["full-test-suite"], ["production-build"],
  ]);
  assert.deepEqual(verificationPlan(["final"]).at(-1)?.map((item) => item.label), ["full-test-suite"]);
  assert.throws(() => verificationPlan(["final", "--skip-tests"]), /accepts only/);
});
