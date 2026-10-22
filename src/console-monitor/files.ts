import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function entries(dir: string, limit = 2048): Promise<string[]> {
  const result: string[] = [];
  try {
    const iterator = await opendir(dir);
    for await (const entry of iterator) {
      result.push(entry.name);
      if (result.length >= limit) break;
    }
  } catch { /* Missing or offline source is not an empty running state. */ }
  return result;
}

/** Enforce real containment and no symlink files; never follow paths from metadata. */
export async function boundedRead(root: string, file: string, maxBytes: number, tail = false): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const canonicalRoot = await realpath(root);
  const parent = await realpath(path.dirname(file));
  if (parent !== canonicalRoot && !parent.startsWith(canonicalRoot + path.sep)) throw new Error("Outside source root");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not a regular file");
    if (!tail && info.size > maxBytes) throw new Error("Metadata exceeds bound");
    const length = Math.min(info.size, maxBytes);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, tail ? Math.max(0, info.size - length) : 0);
    return { text: bytes.subarray(0, bytesRead).toString("utf8"), bytes: info.size, truncated: info.size > length };
  } finally { await handle.close(); }
}

export async function jsonFile<T>(root: string, file: string): Promise<T> {
  return JSON.parse((await boundedRead(root, file, 64 * 1024)).text) as T;
}

export async function fileIdentity(file: string): Promise<string | null> {
  try { const s = await stat(file); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`; }
  catch { return null; }
}
