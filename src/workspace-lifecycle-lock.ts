import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Cross-process exclusion for lease changes versus destructive GC.
 * On a crash the marker remains and GC fails closed until inspected manually.
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
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!acquired) throw new Error("Workspace lifecycle lock busy; GC/lease operation blocked safely");
  try { return await operation(); }
  finally { await rmdir(marker); }
}
