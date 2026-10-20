import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleSession, verifyConsoleSession } from "./console-router.js";

test("owner console session is signed, expiring and isolated from another secret", () => {
  const now = Date.now();
  const token = createConsoleSession("owner-secret-1", now);
  assert.ok(verifyConsoleSession(token, "owner-secret-1", now));
  assert.equal(verifyConsoleSession(token, "owner-secret-2", now), false);
  assert.equal(verifyConsoleSession(token, "owner-secret-1", now + 9 * 60 * 60_000), false);
  assert.equal(verifyConsoleSession(token + "changed", "owner-secret-1", now), false);
  assert.equal(verifyConsoleSession("../../", "owner-secret-1", now), false);
  assert.ok(!token.includes("owner-secret"));
});
