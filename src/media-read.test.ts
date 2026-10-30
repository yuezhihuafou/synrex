import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isVideoPath, parseVideoReadPath, readVideoFrames } from "./media-read.js";

test("video format detection does not mistake text and accepts case variants", () => {
  assert.equal(isVideoPath("session.MP4"), true);
  assert.equal(isVideoPath("capture.webm"), true);
  assert.equal(isVideoPath("report.png"), false);
  assert.equal(isVideoPath("fake.mp4.txt"), false);
  assert.deepEqual(parseVideoReadPath("clip.mp4#compare=1.25,2.5"), { path: "clip.mp4",
    selection: { startSeconds: 1.25, endSeconds: 2.5, compare: true } });
  assert.deepEqual(parseVideoReadPath("clip.mp4#t=0,1"), { path: "clip.mp4",
    selection: { startSeconds: 0, endSeconds: 1, compare: false } });
  assert.deepEqual(parseVideoReadPath("text.txt#t=0,1"), { path: "text.txt#t=0,1" });
});

test("sample local video into bounded, timestamped MCP image blocks", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) {
    t.skip("ffmpeg and ffprobe are not installed"); return;
  }
  const dir = await mkdtemp(join(tmpdir(), "synrex-video-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=6", "-t", "1.5",
    "-threads", "1", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path], { timeout: 10_000 });
  const inspected = await readVideoFrames(path, 4);
  const blocks = inspected.content.filter((item) => item.type === "image");
  assert.equal(blocks.length, 3, "short clips should not create redundant samples");
  assert.equal(inspected.structuredContent.media.frameTimesSeconds.length, 3);
  assert.equal(inspected.structuredContent.media.type, "video");
  for (const block of blocks) {
    assert.equal(block.type, "image");
    if (block.type === "image") {
      assert.equal(block.mimeType, "image/jpeg");
      assert.ok(block.data.length > 200);
      assert.ok(Buffer.from(block.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    }
  }
  assert.ok(!JSON.stringify(inspected.structuredContent).includes(
    blocks[0]!.type === "image" ? blocks[0]!.data : "unavailable"));
  await assert.rejects(readVideoFrames(path, 7), /between 1 and 6/);
  const window = await readVideoFrames(path, { startSeconds: 0.5, endSeconds: 1.25, frames: 3 });
  assert.equal(window.structuredContent.media.startSeconds, 0.5);
  assert.equal(window.structuredContent.media.endSeconds, 1.25);
  assert.equal(window.content.filter(part => part.type === "image").length, 2);
  assert.ok(window.structuredContent.media.frameTimesSeconds.every(time => time >= 0.5 && time <= 1.25));
  const compared = await readVideoFrames(path, { startSeconds: 0.25, endSeconds: 1.25, compare: true });
  assert.equal(compared.structuredContent.media.comparison, true);
  assert.equal(compared.content.filter(part => part.type === "image").length, 3);
  assert.match(compared.structuredContent.result, /Pixel difference/);
  await assert.rejects(readVideoFrames(path, { startSeconds: 1.2, endSeconds: 0.2 }), /time range/);
  await assert.rejects(readVideoFrames(path, { startSeconds: 0.2, endSeconds: 0.25, compare: true }), /0.1 seconds/);
  await writeFile(join(dir, "broken.mp4"), "not a video");
  await assert.rejects(readVideoFrames(join(dir, "broken.mp4")), /Could not inspect video/);
});
