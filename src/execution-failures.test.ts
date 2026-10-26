import assert from "node:assert/strict";
import test from "node:test";
import { assessFailure } from "./execution-failures.js";

test("failure classification distinguishes repair, permission, external evidence, and unknown", () => {
  assert.equal(assessFailure({exitCode: 1, error: "npm fetch failed: ECONNRESET"}).kind, "recoverable");
  assert.equal(assessFailure({exitCode: 1, error: "AssertionError expected x"}).kind, "recoverable");
  assert.equal(assessFailure({exitCode: 1, error: "EACCES permission denied"}).kind, "requires_authorization");
  assert.equal(assessFailure({exitCode: 1, error: "account suspended"}).kind, "external_blocker");
  assert.equal(assessFailure({exitCode: 23, error: "unknown error"}).kind, "indeterminate");
  assert.equal(assessFailure({exitCode: 1, error: "permission denied", knownExpected: true}).kind, "indeterminate");
  assert.equal(assessFailure({exitCode: 0, error: "permission denied in expected output"}).kind, "indeterminate");
});
