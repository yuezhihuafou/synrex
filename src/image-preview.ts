/** Bounded image previews for MCP's inline image transport.
 * The original file is never changed; high-resolution work can use a crop
 * or a later dedicated artifact flow without pushing large base64 payloads.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const INLINE_BYTES = 120_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface ImagePreview {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  structuredContent: {
    result: string;
    media: { type: "image"; preview: true; originalBytes: number; previewBytes: number; maxEdge: number };
  };
}

/** Returns undefined when a small image should retain the original Pi read path. */
export async function readBoundedImagePreview(path: string): Promise<ImagePreview | undefined> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Image must be a regular file.");
  if (info.size > MAX_SOURCE_BYTES) throw new Error("Image exceeds 64 MiB; use a smaller image.");
  if (info.size <= INLINE_BYTES) return undefined;

  for (const edge of [1024, 768, 512, 384]) {
    let bytes: Buffer;
    try {
      const { stdout } = await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
        "-i", path, "-frames:v", "1",
        "-vf", `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "8", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ], { timeout: 6_000, maxBuffer: INLINE_BYTES * 6, encoding: "buffer" });
      bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") continue;
      throw new Error("Could not decode image preview (ffmpeg missing, timeout, or invalid image).");
    }
    if (bytes.length > INLINE_BYTES) continue;
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Image preview decoder returned invalid JPEG.");
    }
    const result = `Image JPEG preview ${bytes.length} bytes; original ${info.size} bytes retained at the source path. Preview is lossy and may omit fine details.`;
    return {
      content: [{ type: "text", text: result },
        { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") }],
      structuredContent: {
        result,
        media: { type: "image", preview: true, originalBytes: info.size, previewBytes: bytes.length, maxEdge: edge },
      },
    };
  }
  throw new Error("Image preview exceeds 120 KiB transport budget even at reduced resolution.");
}
