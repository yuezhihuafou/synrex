import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { readRosImage } from "./ros2-camera-read.js";

test("ROS2 adapter validates topic and preserves frame provenance", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  let called = 0;
  const result = await readRosImage("/camera/color/image_raw", {
    python: "test-python",
    runPython: (async (_bin: string, args: string[]) => {
      called++;
      assert.ok(args.includes("/camera/color/image_raw"));
      return { stdout: JSON.stringify({ data: jpeg, mimeType: "image/jpeg", topicFrameId: "camera_color_optical_frame",
        stampNanoseconds: "1800000000123456789", width: 640, height: 480, encoding: "rgb8" }) };
    }) as never,
  });
  assert.equal(called, 1);
  assert.equal(result.content.filter(block => block.type === "image").length, 1);
  assert.equal(result.structuredContent.media.frameId, "camera_color_optical_frame");
  assert.equal(result.structuredContent.media.stampNanoseconds, "1800000000123456789");
  await assert.rejects(readRosImage("/camera;rm /tmp/x"), /topic/);
  await assert.rejects(readRosImage("relative/topic"), /topic/);
});

test("ROS2 adapter reports missing rclpy rather than inventing an image", async () => {
  await assert.rejects(readRosImage("/camera/image_raw", {
    runPython: (async () => { throw new Error("ModuleNotFoundError: No module named 'rclpy'"); }) as never,
  }), /rclpy\/sensor_msgs/);
});

test("ROS2 helper can convert raw rgb bytes without requiring rclpy", () => {
  const script = `import runpy\nm=runpy.run_path('scripts/ros2-image-snapshot.py',run_name='not_main')\n` +
    `jpg=m['jpeg_from_raw'](bytes([255,0,0,0,255,0,0,0,255,255,255,255]),2,2,6,'rgb8')\n` +
    `assert jpg[:2]==bytes([255,216])\nprint(len(jpg))`;
  const result = execFileSync("python3", ["-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.ok(Number(result.trim()) > 100);
});

test("ROS2 high-entropy images are resized into the cross-node image budget", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    t.skip("ffmpeg unavailable"); return;
  }
  const script = `import runpy, random, subprocess
m=runpy.run_path('scripts/ros2-image-snapshot.py',run_name='not_main')
raw=random.Random(20261026).randbytes(640*480*3)
args=['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-threads','1',
      '-f','rawvideo','-pix_fmt','rgb24','-s','640x480','-i','pipe:0',
      '-frames:v','1','-q:v','2','-f','image2pipe','-vcodec','mjpeg','pipe:1']
jpg=subprocess.run(args,input=raw,stdout=subprocess.PIPE,check=True,timeout=8).stdout
assert len(jpg)>120000
result=m['bounded_jpeg'](jpg)
assert 4<=len(result)<=120000 and result[:2]==bytes([255,216])
print(len(jpg),len(result))`;
  const output = execFileSync("python3", ["-c", script], { encoding: "utf8", timeout: 20_000 });
  assert.match(output, /\d+ \d+/);
});

test("ROS2 adapter uses configured remote peer without requiring local rclpy", async () => {
  const prior = process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET;
  process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET = "swy@192.0.2.10";
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const result = await readRosImage("/camera/wrist_camera/depth/image_rect_raw", {
      remoteSnapshot: async (topic, target, container) => {
        assert.equal(target, "swy@192.0.2.10");
        assert.equal(container, "ur5_ros2_humble_dev");
        assert.equal(topic, "/camera/wrist_camera/depth/image_rect_raw");
        return JSON.stringify({ data: jpeg, mimeType: "image/jpeg", topicFrameId: "depth_optical_frame",
          stampNanoseconds: "1800000000123456789", width: 640, height: 480,
          encoding: "16UC1", visualization: "relative-depth-pseudocolor" });
      },
    });
    assert.match(result.structuredContent.result, /relative pseudocolor, not metric depth/);
    assert.equal(result.structuredContent.media.encoding, "16UC1");
  } finally {
    if (prior === undefined) delete process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET;
    else process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET = prior;
  }
});

test("real camera ROS2 SSH subscriber (explicit integration test)", async (t) => {
  if (!process.env.SYNREX_TEST_ROS_TOPIC || !process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET) {
    t.skip("Live ROS2 target not configured"); return;
  }
  const response = await readRosImage(process.env.SYNREX_TEST_ROS_TOPIC);
  assert.equal(response.structuredContent.media.type, "ros2-image");
  assert.ok(response.content.some(block => block.type === "image"));
  assert.match(response.structuredContent.media.stampNanoseconds, /^\d+$/);
  t.diagnostic(response.structuredContent.result);
});
