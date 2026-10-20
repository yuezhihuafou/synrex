import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runtimeBuildFingerprint,
  sourceFingerprint,
  sourceProvenanceDrifted,
} from "./local-node.js";

test("runtime build fingerprint is stable and bounded", () => {
  const first = runtimeBuildFingerprint();
  const second = runtimeBuildFingerprint();
  assert.match(first, /^[0-9a-f]{20}$/);
  assert.equal(second, first);
});

test("source fingerprint is stable for the checkout", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.match(sourceFingerprint(root), /^[0-9a-f]{20}$/);
  assert.equal(sourceFingerprint(root), sourceFingerprint(root));
});

test("source drift detects build/checkout mismatch", () => {
  assert.equal(
    sourceProvenanceDrifted(
      { revision: "abc", fingerprint: "one", dirty: true },
      { revision: "abc", fingerprint: "one", dirty: true },
    ),
    false,
  );
  assert.equal(
    sourceProvenanceDrifted(
      { revision: "abc", fingerprint: "one", dirty: true },
      { revision: "abc", fingerprint: "two", dirty: true },
    ),
    true,
  );
  assert.equal(sourceProvenanceDrifted(undefined, { revision: "abc" }), undefined);
});
