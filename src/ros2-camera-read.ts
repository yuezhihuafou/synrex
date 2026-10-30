/** ROS2 snapshot adapter: single read-only subscription, no ROS runtime in Synrex. */
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE_TOPIC = /^\/(?:[A-Za-z][A-Za-z0-9_]*)(?:\/[A-Za-z][A-Za-z0-9_]*)*$/;
const SNAPSHOT_SCRIPT = fileURLToPath(new URL("../scripts/ros2-image-snapshot.py", import.meta.url));
const SSH_TARGET = /^(?:[a-zA-Z_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.:-]*$/;
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/;

/** Run a bounded one-shot ROS subscriber inside the preexisting ROS2 container.
 * The Python script is piped through SSH stdin, never copied to swy1. */
async function remoteRosSnapshot(topic: string, target: string, container: string): Promise<string> {
  if (!SSH_TARGET.test(target) || !CONTAINER_NAME.test(container)) {
    throw new Error("Invalid configured ROS2 SSH target or container name.");
  }
  const script = await readFile(SNAPSHOT_SCRIPT);
  const command = `docker exec -i ${container} bash -lc "source /opt/ros/humble/setup.bash && exec /usr/bin/python3 - '${topic}' --timeout 6"`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
      "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=2", "-T", target, command],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputSize = 0, errorSize = 0, settled = false;
    const finish = (error?: Error, data?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(data ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ROS2 remote subscriber timed out after 14 seconds"));
    }, 14_000);
    child.on("error", error => finish(error));
    child.stdout.on("data", (part: Buffer) => {
      outputSize += part.length;
      if (outputSize > 850_000) {
        child.kill("SIGKILL");
        finish(new Error("ROS2 snapshot exceeded the response size limit"));
      } else stdout.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      errorSize += part.length;
      if (errorSize < 4096) stderr.push(part);
    });
    child.on("close", code => {
      if (code !== 0) {
        const reason = Buffer.concat(stderr).toString("utf8").trim().slice(0, 260);
        finish(new Error(`ROS2 remote subscription failed: ${reason || `ssh exit ${code}`}`));
      } else finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", () => { /* close handler owns process failure */ });
    child.stdin.end(script);
  });
}

export interface RosImageInspection {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" }>;
  structuredContent: { result: string; media: { type: "ros2-image"; topic: string; frameId: string;
    stampNanoseconds: string; width: number | null; height: number | null; encoding: string } };
}

export async function readRosImage(topic: string, options: {
  runPython?: typeof run;
  python?: string;
  remoteSnapshot?: (topic: string, target: string, container: string) => Promise<string>;
} = {}): Promise<RosImageInspection> {
  if (topic.length > 160 || !IMAGE_TOPIC.test(topic)) {
    throw new Error("ROS2 image topic must be an absolute name with valid topic segments.");
  }
  const python = options.python ?? process.env.SYNREX_ROS_PYTHON ?? "python3";
  const sshTarget = process.env.SYNREX_ROS_SNAPSHOT_SSH_TARGET;
  let parsed: Record<string, unknown>;
  try {
    const stdout = sshTarget && !options.runPython
      ? await (options.remoteSnapshot ?? remoteRosSnapshot)(topic, sshTarget,
        process.env.SYNREX_ROS_SNAPSHOT_CONTAINER ?? "ur5_ros2_humble_dev")
      : (await (options.runPython ?? run)(python,
        [SNAPSHOT_SCRIPT, topic, "--timeout", "6"],
        { timeout: 14_000, maxBuffer: 850_000, encoding: "utf8" })).stdout;
    parsed = JSON.parse(String(stdout)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Do not echo arbitrary command stderr/data from a ROS environment.
    if (/rclpy|sensor_msgs|ModuleNotFoundError/.test(message)) {
      throw new Error("ROS2 Python support is not installed on this Synrex execution node (rclpy/sensor_msgs).");
    }
    if (/No ROS2 image arrived|TimeoutError/.test(message)) {
      throw new Error(`No ROS2 image arrived on ${topic} within 6 seconds.`);
    }
    throw new Error(`ROS2 snapshot failed on this execution node: ${message.slice(0, 220)}`);
  }
  const data = parsed.data;
  const stamp = parsed.stampNanoseconds;
  if (parsed.mimeType !== "image/jpeg" || typeof data !== "string" || data.length > 700_000
    || typeof stamp !== "string" || !/^\d{1,24}$/.test(stamp)
    || typeof parsed.topicFrameId !== "string" || typeof parsed.encoding !== "string") {
    throw new Error("ROS2 snapshot helper returned invalid or oversized image metadata.");
  }
  const jpeg = Buffer.from(data, "base64");
  if (jpeg.length < 4 || jpeg.length > 512 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("ROS2 snapshot helper did not return a bounded JPEG image.");
  }
  const frameId = parsed.topicFrameId.slice(0, 120);
  const encoding = parsed.encoding.slice(0, 100);
  const visualization = parsed.visualization === "relative-depth-pseudocolor"
    ? "; depth visualization is relative pseudocolor, not metric depth" : "";
  const result = `ROS2 image ${topic}; source frame_id=${frameId || "(empty)"}; header stamp=${stamp} ns; encoding=${encoding}${visualization}. No TF inference.`;
  return { content: [{ type: "text", text: result }, { type: "image", data, mimeType: "image/jpeg" }],
    structuredContent: { result, media: {
      type: "ros2-image", topic, frameId, stampNanoseconds: stamp,
      width: typeof parsed.width === "number" ? parsed.width : null,
      height: typeof parsed.height === "number" ? parsed.height : null,
      encoding,
    } },
  };
}
