/** Cross-process, monotonic durable-task state transitions. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DurableTaskState } from "./durable-task-model.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export async function commitDurableTaskState(
  taskPath: string, next: DurableTaskState, expected?: DurableTaskState,
): Promise<DurableTaskState> {
  const marker = taskPath + ".state-lock";
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(marker);
      locked = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(marker).catch(() => undefined);
      // Recover crashed writers after two minutes; a state write is normally milliseconds.
      if (info && Date.now() - info.mtimeMs > 120_000) {
        await rm(marker, { recursive: true, force: true }).catch(() => undefined);
      }
      await delay(20);
    }
  }
  if (!locked) throw new Error("Durable task state writer lock timed out");
  try {
    let current: DurableTaskState | undefined;
    try {
      current = JSON.parse(await readFile(taskPath, "utf8")) as DurableTaskState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (expected) throw error;
      // Standalone runner also supports a task without an initial manager state.
    }
    if (current && terminalStatuses.has(current.status)) return current;
    if (expected && JSON.stringify(current) !== JSON.stringify(expected)) return current!;
    const temporary = taskPath + ".tmp-" + process.pid + "-" + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, taskPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return next;
  } finally {
    await rm(marker, { recursive: true, force: true });
  }
}
