import assert from "node:assert/strict";
import test from "node:test";
import { reviewCardPayload } from "./review-card-payload.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";

const sample = (patch: string, count = 1): ReviewChangesResult => ({
  reviewRef: "a".repeat(40),
  result: `Changed ${count} files.`,
  summary: { files: count, additions: count, removals: 0 },
  files: Array.from({ length: count }, (_, i) => ({
    path: `src/${i}.ts`, type: "change" as const, additions: 1, removals: 0,
  })),
  patch,
});

test("small diffs preserve the full inline review experience", () => {
  const patch = "diff --git a/a b/a\n+hello\n";
  const card = reviewCardPayload(sample(patch));
  assert.equal(card.payload.patch, patch);
  assert.equal("patchOmitted" in card.summary, false);
  assert.equal(card.reviewRef, "a".repeat(40));
});

test("large diffs retain a stable reference and counts but never inline the patch", () => {
  const card = reviewCardPayload(sample("改".repeat(40_000), 163));
  assert.equal(card.payload.patch, "");
  assert.equal((card.summary as { patchOmitted?: boolean }).patchOmitted, true);
  assert.equal(card.summary.files, 163);
  assert.equal(card.files.length, 163);
  assert.equal(card.reviewRef, "a".repeat(40));
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 75_000);
});

test("large review file lists are bounded independently of the diff payload", () => {
  const card = reviewCardPayload(sample("x".repeat(100_000), 400));
  assert.equal(card.summary.files, 400);
  assert.equal((card.summary as { omittedFileCount?: number }).omittedFileCount, 200);
  assert.equal(card.files.length, 200);
});
