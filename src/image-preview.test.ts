import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isImagePath, readBoundedImagePreview } from "./image-preview.js";

test("recognize supported image files, not extension lookalikes", () => {
  assert.equal(isImagePath("image.PNG"), true);
  assert.equal(isImagePath("image.webp"), true);
  assert.equal(isImagePath("image.png.txt"), false);
});

test("oversized inline PNG becomes bounded real JPEG image content", async t => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) { t.skip("ffmpeg unavailable"); return; }
  const png = fileURLToPath(new URL("../docs/assets/v11-review-ui-before.png", import.meta.url));
  const result = await readBoundedImagePreview(png);
  assert.ok(result);
  assert.equal(result.structuredContent.media.type, "image");
  assert.ok(result.structuredContent.media.previewBytes <= 120_000);
  assert.ok(result.content.some(item => item.type === "image" && item.mimeType === "image/jpeg"));
  assert.equal(JSON.stringify(result.structuredContent).includes("base64"), false);
});
