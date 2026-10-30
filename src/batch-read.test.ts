import assert from "node:assert/strict";
import test from "node:test";
import { readBatch, validateBatchFiles } from "./batch-read.js";

test("batch read returns ordered full text and independent errors", async () => {
  const files = validateBatchFiles([
    { path: "slow.ts", offset: 4, limit: 22 },
    { path: "missing.ts" },
    { path: "quick.ts", limit: 8 },
  ]);
  let active = 0;
  let peak = 0;
  const response = await readBatch(files, async (file) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, file.path === "slow.ts" ? 20 : 2));
    active--;
    if (file.path === "missing.ts") throw new Error("ENOENT missing.ts");
    return { structuredContent: { result: `full text ${file.path}` } };
  }, 3);
  assert.ok(peak > 1);
  assert.deepEqual(response.structuredContent.files.map((file) => file.path), ["slow.ts", "missing.ts", "quick.ts"]);
  assert.deepEqual(response.structuredContent.files.map((file) => file.limit), [22, 250, 8]);
  assert.equal(response.structuredContent.files[0]?.offset, 4);
  assert.equal(response.structuredContent.files[0]?.result, "full text slow.ts");
  assert.match(response.structuredContent.files[1]?.result ?? "", /ENOENT/);
  assert.equal(response.structuredContent.errorCount, 1);
  assert.equal(response.isError, true);
});

test("batch size bounds retain original file text", async () => {
  assert.throws(() => validateBatchFiles([]), /1 to 8/);
  assert.throws(() => validateBatchFiles(Array.from({ length: 9 }, (_, n) => ({ path: String(n) }))), /1 to 8/);
  assert.throws(() => validateBatchFiles([{ path: "a", limit: 501 }]), /Invalid limit/);
  const text = "source".repeat(10_000);
  const result = await readBatch([{ path: "file.ts" }], async () => ({ structuredContent: { result: text } }));
  assert.equal(result.structuredContent.files[0]?.result, text);
});

test("batch read keeps image blocks without embedding encoded bytes in structured text", async () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
  const result = await readBatch([{ path: "photo.png" }, { path: "a.txt" }], async file => ({
    content: file.path === "photo.png" ? [{ type: "text", text: "Read image" }, image]
      : [{ type: "text", text: "regular text" }],
    structuredContent: file.path === "photo.png" ? {
      result: "Read image", observation: { observationId: "obs_1", source: { kind: "file.image" } },
    } : undefined,
  }));
  assert.equal(result.content.filter(item => item.type === "image").length, 1);
  assert.equal(result.content.some(item => item.type === "image" && item.data === image.data), true);
  assert.ok(JSON.stringify(result.structuredContent).includes("photo.png"));
  assert.ok(!JSON.stringify(result.structuredContent).includes(image.data));
  assert.deepEqual(result.structuredContent.observations, [
    { path: "photo.png", observation: { observationId: "obs_1", source: { kind: "file.image" } } },
  ]);
});
