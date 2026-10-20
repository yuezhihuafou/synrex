import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReleaseSource, type ReleaseSourceEvidence } from "./release-source-check.js";

const valid: ReleaseSourceEvidence = {
  head: "abc123", sourceDirty: false, buildRevision: "abc123", buildDirty: false,
  currentFingerprint: "f1", buildFingerprint: "f1", requiredAssetsPresent: true,
};

test("immutable-release source gate accepts matching clean evidence", () => {
  assert.deepEqual(evaluateReleaseSource(valid), []);
});

test("dirty source cannot be disguised by an up-to-date build", () => {
  assert.match(evaluateReleaseSource({ ...valid, sourceDirty: true }).join(" "), /Git-clean/);
  assert.match(evaluateReleaseSource({ ...valid, buildDirty: true }).join(" "), /Git-clean/);
});

test("mismatched revisions, fingerprints and incomplete assets all block release", () => {
  const errors = evaluateReleaseSource({
    ...valid, buildRevision: "outdated", buildFingerprint: "wrong", requiredAssetsPresent: false,
  });
  assert.equal(errors.length, 3);
});
