import assert from "node:assert/strict";
import test from "node:test";
import { medianOrNull } from "./benchmark-statistics.js";

test("median primitive preserves ordering and original input", () => {
  const even = [9, 1, 3, 7];
  assert.equal(medianOrNull(even), 5);
  assert.deepEqual(even, [9, 1, 3, 7]);
  assert.equal(medianOrNull([9, 1, 3]), 3);
  assert.equal(medianOrNull([]), null);
});
