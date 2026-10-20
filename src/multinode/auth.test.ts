import assert from "node:assert/strict";
import test from "node:test";
import { bearerToken, deriveNodeToken, generateNodeJoinToken, safeTokenEquals } from "./auth.js";

test("node credentials are derived per node and compare safely", () => {
  const joinToken = generateNodeJoinToken();
  const first = deriveNodeToken(joinToken, "node_first");
  const second = deriveNodeToken(joinToken, "node_second");
  assert.match(first, /^dn1_/);
  assert.notEqual(first, second);
  assert.equal(safeTokenEquals(first, first), true);
  assert.equal(safeTokenEquals(first, second), false);
  assert.equal(bearerToken(`Bearer ${first}`), first);
});
