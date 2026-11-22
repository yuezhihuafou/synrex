import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STALE_LOCK_MS = 2 * 60_000;

async function reclaimDeadLock(marker: string): Promise<void> {
  const info = await stat(marker).catch(() => undefined);
  if (!info || Date.now() - info.mtimeMs < STALE_LOCK_MS) return;
  let owner: { pid?: number } | undefined;
  try {
    owner = JSON.parse(await readFile(join(marker, "owner.json"), "utf8")) as { pid?: number };
  } catch {
    // A crash between mkdir and the ownership record leaves an old empty lock.
  }
  if (owner?.pid && Number.isInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      return; // Still alive, including permission errors for a foreign process.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
  }
  await rm(marker, { recursive: true, force: true }).catch(() => undefined);
}

/** Cross-process exclusion for lease changes versus destructive GC.
 * Recover only definitely orphaned, old owner markers; otherwise fail closed.
 */
export async function withWorkspaceLifecycleLock<T>(
  stateDir: string, operation: () => Promise<T>,
): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const marker = join(stateDir, ".worktree-lifecycle-lock");
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await mkdir(marker);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaimDeadLock(marker);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!acquired) throw new Error("Workspace lifecycle lock busy; GC/lease operation blocked safely");
  try {
    await writeFile(join(marker, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { mode: 0o600 });
    return await operation();
  } finally {
    await rm(marker, { recursive: true, force: true });
  }
}
