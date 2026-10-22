import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { DurableTaskManager } from "../durable-tasks.js";
import type { DurableTaskState } from "../durable-task-model.js";
import type { ProcessRunMetadata } from "../compact-runtime/process-run-store.js";
import { boundedRead, entries, jsonFile } from "./files.js";
import type { Execution } from "./types.js";

const RUN = /^run_[a-zA-Z0-9_-]{1,100}$/;
export const RUN_LIMIT = 600;
export const LOG_LIMIT = 64 * 1024;
export const active = (status: string) => status === "working" || status === "input_required";

export class ExecutionReader {
  private locations = new Map<string, string>();
  private finished = new Map<string, Execution>();
  constructor(readonly runRoot: string, readonly writableRoots: string[] = []) {}

  async sample(): Promise<{ executions: Execution[]; truncated: boolean }> {
    const locations = new Map<string, string>();
    // Active markers first: old long-running jobs must not fall out of the recent list.
    for (const workspace of await entries(path.join(this.runRoot, ".task-active"), 256)) {
      const folder = path.join(this.runRoot, ".task-active", workspace);
      for (const marker of await entries(folder, 256)) {
        if (locations.size >= RUN_LIMIT) break;
        try {
          const value = await jsonFile<{ taskPath: string }>(this.runRoot, path.join(folder, marker));
          const dir = path.dirname(value.taskPath);
          if (RUN.test(path.basename(dir))) locations.set(path.basename(dir), dir);
        } catch { /* Concurrent completion. */ }
      }
    }
    const days = (await entries(this.runRoot, 4096)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse();
    let truncated = false;
    for (const day of days) {
      const runs = (await entries(path.join(this.runRoot, day), 4096)).filter(x => RUN.test(x)).sort().reverse();
      for (const run of runs) {
        if (locations.size >= RUN_LIMIT) { truncated = true; break; }
        locations.set(run, path.join(this.runRoot, day, run));
      }
      if (truncated) break;
    }
    this.locations = locations;
    for (const key of this.finished.keys()) if (!locations.has(key)) this.finished.delete(key);
    const executions: Execution[] = [];
    const pairs = [...locations];
    // Bounded concurrency; never synchronous filesystem scans on the service thread.
    for (let i = 0; i < pairs.length; i += 12) {
      const rows = await Promise.all(pairs.slice(i, i + 12).map(async ([run, dir]) => this.read(run, dir).catch(() => null)));
      for (const row of rows) if (row) {
        executions.push(row);
        if (["completed", "failed", "cancelled"].includes(row.status)) this.finished.set(row.runId, row);
      }
    }
    return { executions: executions.sort((a, b) => Number(active(b.status)) - Number(active(a.status)) || b.startedAt.localeCompare(a.startedAt)), truncated };
  }

  private async read(run: string, dir: string): Promise<Execution | null> {
    if (this.finished.has(run)) return this.finished.get(run)!;
    try {
      const task = await jsonFile<DurableTaskState>(this.runRoot, path.join(dir, "task.json"));
      if (task.runId !== run || !task.root || !task.createdAt) return null;
      const writable = await this.isWritable(task.root);
      let status: string = task.status;
      if (active(status) && task.runnerPid) {
        try { process.kill(task.runnerPid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") status = "unconfirmed"; }
      }
      return {
        runId: run, taskId: task.taskId, workspaceId: task.workspaceId,
        project: path.basename(task.root), cwd: task.cwd, command: task.command,
        status, startedAt: task.createdAt, finishedAt: task.finishedAt,
        lastActivityAt: task.lastActivityAt,
        durationMs: Math.max(0, (task.finishedAt ? Date.parse(task.finishedAt) : Date.now()) - Date.parse(task.createdAt)),
        outputBytes: task.outputBytes, exitCode: task.exitCode ?? null,
        runnerPid: task.runnerPid, childPid: task.childPid,
        canCancel: writable && active(status), observation: "durable-task-state",
      };
    } catch { /* Synchronous commands and historical PTY runs have only meta.json. */ }
    try {
      const meta = await jsonFile<ProcessRunMetadata>(this.runRoot, path.join(dir, "meta.json"));
      if (meta.runId !== run || !meta.startedAt) return null;
      return { runId: run, project: path.basename(meta.root), cwd: meta.cwd, command: meta.command,
        status: meta.isError ? "failed" : "completed", startedAt: meta.startedAt, finishedAt: meta.finishedAt,
        durationMs: meta.durationMs, outputBytes: meta.outputBytes, exitCode: meta.exitCode,
        canCancel: false, observation: "finished-run-metadata" };
    } catch { return null; } // Missing metadata must never be presented as completed.
  }

  private async isWritable(root: string): Promise<boolean> {
    const resolved = await realpath(root).catch(() => "");
    return resolved !== "" && this.writableRoots.includes(resolved);
  }

  async output(run: string) {
    const dir = this.locations.get(run);
    if (!dir || !RUN.test(run)) throw new Error("Unknown run");
    const result = await boundedRead(this.runRoot, path.join(dir, "output.log"), LOG_LIMIT, true);
    const execution = await this.read(run, dir);
    return { ...result, command: execution?.command ?? "" };
  }

  async cancel(run: string): Promise<{ status: string; taskId?: string }> {
    const dir = this.locations.get(run);
    if (!dir) throw new Error("Unknown run");
    const row = await this.read(run, dir);
    if (!row?.taskId || !await this.isWritable((await jsonFile<DurableTaskState>(this.runRoot, path.join(dir, "task.json"))).root)) throw new Error("Management is disabled for this workspace");
    if (!active(row.status)) return { status: row.status, taskId: row.taskId };
    // Write the same pre-launch marker used by the existing task manager.
    const root = await realpath(this.runRoot);
    const parent = await realpath(dir);
    if (!parent.startsWith(root + path.sep)) throw new Error("Outside run root");
    const handle = await open(path.join(parent, "cancel.requested"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; });
    if (handle) { try { await handle.writeFile(new Date().toISOString() + "\n"); } finally { await handle.close(); } }
    const state = await jsonFile<DurableTaskState>(this.runRoot, path.join(dir, "task.json"));
    if (state.unitName && state.unitName !== `devspace-task-${run}`) throw new Error("Unexpected task unit identity");
    if (state.runnerPid) {
      const { readFile } = await import("node:fs/promises");
      const args = (await readFile(`/proc/${state.runnerPid}/cmdline`, "utf8")).split("\0");
      if (!args.some(arg => /durable-task-runner\.(js|ts)$/.test(arg)) || !args.includes(path.join(parent, "request.json"))) throw new Error("Runner identity changed; refresh state");
      // Existing cancellation stops its own systemd unit/process group and records completion.
      await new DurableTaskManager({ runRoot: this.runRoot }).cancel(state.root, state.taskId);
    }
    return { status: "cancel_requested", taskId: row.taskId };
  }
}
