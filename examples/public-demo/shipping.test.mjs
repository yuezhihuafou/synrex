import assert from "node:assert/strict";
import { test } from "node:test";
import { totalWithShipping } from "./shipping.mjs";

test("ordinary orders include shipping", () => {
  assert.equal(totalWithShipping(99, 8, 100), 107);
});

test("orders meeting the threshold get free shipping", () => {
  // Deliberately failing boundary test: ask Synrex to identify and fix it.
  assert.equal(totalWithShipping(100, 8, 100), 100);
});
