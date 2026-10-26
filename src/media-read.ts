/** Bounded video inspection for ordinary MCP image-capable chat clients.
 * MCP has an image block, not an interoperable video-frame block. A video is
 * represented as sampled JPEG frames with timestamps, not as base64 text. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpeg", ".mpg"]);
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
// The practical MCP host payload limit can be lower than the peer's 2 MiB
// JSON limit. Bound the entire sampled sequence, not only each frame.
const MAX_FRAME_BYTES = 120_000;
const MAX_TOTAL_FRAME_BYTES = 180_000;
const MAX_EDGE = 768;

export type MediaContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" };
export interface VideoInspection {
  [key: string]: unknown;
  content: MediaContent[];
  structuredContent: {
    result: string;
    media: { type: "video"; durationSeconds: number; width: number; height: number; frameTimesSeconds: number[];
      startSeconds: number; endSeconds: number; comparison: boolean };
  };
}

export function isVideoPath(file: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(file).toLowerCase());
}

/** Path suffix fallback for older ChatGPT coordinator schemas. */
export function parseVideoReadPath(path: string): { path: string; selection?: VideoSelection } {
  const match = /^(.*)#(t|compare)=([0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?)$/.exec(path);
  if (!match || !isVideoPath(match[1]!)) return { path };
  return { path: match[1]!, selection: {
    startSeconds: Number(match[3]), endSeconds: Number(match[4]), compare: match[2] === "compare",
  } };
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function displaySeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function renderVideoPreview(
  file: string, width: number, height: number, firstTime: number,
  budget: number, secondTime?: number,
): Promise<Buffer> {
  for (const edge of [MAX_EDGE, 640, 512, 384, 256]) {
    const factor = Math.min(1, edge / Math.max(width, height));
    const w = Math.max(2, Math.round(width * factor / 2) * 2);
    const h = Math.max(2, Math.round(height * factor / 2) * 2);
    const filter = secondTime === undefined
      ? `scale=${w}:${h}:flags=fast_bilinear`
      : `[0:v]scale=${w}:${h}:flags=fast_bilinear[a];`
        + `[1:v]scale=${w}:${h}:flags=fast_bilinear[b];[a][b]blend=all_mode=difference[out]`;
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
      "-ss", String(firstTime), "-i", file,
      ...(secondTime === undefined ? ["-map", "0:v:0", "-vf", filter]
        : ["-ss", String(secondTime), "-i", file, "-filter_complex", filter, "-map", "[out]"]),
      "-frames:v", "1", "-an", "-sn", "-dn",
      "-q:v", "8", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ];
    let bytes: Buffer;
    try {
      const { stdout } = await run("ffmpeg", args,
        { timeout: secondTime === undefined ? 6_000 : 8_000, maxBuffer: 512 * 1024, encoding: "buffer" });
      bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    } catch {
      // A too-large first output should not prevent a smaller second attempt.
      continue;
    }
    if (bytes.length >= 4 && bytes.length <= budget && bytes[0] === 0xff && bytes[1] === 0xd8) return bytes;
  }
  throw new Error("Could not render video preview within the bounded transport budget; select fewer frames or a shorter interval.");
}

export interface VideoSelection {
  frames?: number;
  startSeconds?: number;
  endSeconds?: number;
  compare?: boolean;
}

export async function readVideoFrames(file: string, options: VideoSelection | number = {}): Promise<VideoInspection> {
  const input = typeof options === "number" ? { frames: options } : options;
  const requestedFrames = input.frames ?? 4;
  if (!Number.isInteger(requestedFrames) || requestedFrames < 1 || requestedFrames > 6) {
    throw new Error("Video frames must be an integer between 1 and 6.");
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Video path is not a regular file.");
  if (info.size > MAX_VIDEO_BYTES) {
    throw new Error("Video exceeds 512 MiB. Export a shorter clip before reading it through MCP.");
  }
  let details: { streams?: Array<{ width?: number; height?: number; duration?: string }>; format?: { duration?: string } };
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,duration:format=duration", "-of", "json", file,
    ], { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    details = JSON.parse(stdout) as typeof details;
  } catch {
    throw new Error("Could not inspect video; install ffprobe and provide a decodable video file.");
  }
  const track = details.streams?.[0];
  const width = track?.width, height = track?.height;
  if (!width || !height || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error("Video has no supported visual stream.");
  }
  const duration = positiveNumber(details.format?.duration) ?? positiveNumber(track.duration);
  if (!duration) throw new Error("Video duration is unavailable. Export a clip with a valid duration first.");
  const start = input.startSeconds ?? 0;
  const end = input.endSeconds ?? duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > duration + 0.01) {
    throw new Error("Video time range must satisfy 0 <= startSeconds < endSeconds <= duration.");
  }
  if (input.compare && end - start < 0.1) throw new Error("Frame comparison requires at least 0.1 seconds of separation.");
  const span = end - start;
  const count = input.compare ? 2 : Math.min(requestedFrames, Math.max(1, Math.ceil(span * 2)));
  const lastSafeTime = Math.max(0, duration - 0.05);
  const frameTimes = input.compare
    ? [displaySeconds(Math.min(start, lastSafeTime)), displaySeconds(Math.min(end - 0.01, lastSafeTime))]
    : Array.from({ length: count }, (_, index) =>
      displaySeconds(Math.min(lastSafeTime, start + span * (index + 0.5) / count)));
  const content: MediaContent[] = [];
  let totalFrameBytes = 0;
  const frameBudget = Math.min(MAX_FRAME_BYTES, Math.floor(MAX_TOTAL_FRAME_BYTES / (count + (input.compare ? 1 : 0))));
  const overview = `Video ${width}x${height}, ${displaySeconds(duration)}s, interval ${displaySeconds(start)}-${displaySeconds(end)}s. Sampled ${count} visual frames (no audio transcription).`;
  content.push({ type: "text", text: overview });
  for (let index = 0; index < count; index++) {
    const seconds = frameTimes[index]!;
    const bytes = await renderVideoPreview(file, width, height, seconds, frameBudget);
    totalFrameBytes += bytes.length;
    if (totalFrameBytes > MAX_TOTAL_FRAME_BYTES) {
      throw new Error("Video preview exceeds the 180 KiB aggregate frame budget; use fewer frames.");
    }
    content.push({ type: "text", text: `Frame ${index + 1}/${count} @ ${seconds}s` });
    content.push({ type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") });
  }
  if (input.compare) {
    const difference = await renderVideoPreview(file, width, height, frameTimes[0]!, frameBudget, frameTimes[1]!);
    totalFrameBytes += difference.length;
    if (difference.length < 4 || difference.length > MAX_FRAME_BYTES || totalFrameBytes > MAX_TOTAL_FRAME_BYTES) {
      throw new Error("Visual comparison exceeds the bounded media response budget.");
    }
    content.push({ type: "text", text: `Pixel difference between ${frameTimes[0]}s and ${frameTimes[1]}s (brightness shows changed pixels; camera motion also contributes).` });
    content.push({ type: "image", mimeType: "image/jpeg", data: difference.toString("base64") });
  }
  return { content, structuredContent: {
    result: [overview, ...frameTimes.map((time, index) => `Frame ${index + 1}/${count} @ ${time}s`),
      ...(input.compare ? ["Pixel difference provided as the last image block"] : [])].join("\n"),
    media: { type: "video", durationSeconds: displaySeconds(duration), width, height, frameTimesSeconds: frameTimes,
      startSeconds: displaySeconds(start), endSeconds: displaySeconds(end), comparison: input.compare === true },
  } };
}
