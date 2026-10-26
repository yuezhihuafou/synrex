import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStoreRoot } from "./compact-runtime/run-store.js";
import { currentRequestLogContext } from "./logger.js";
import { traceEvent, traceStage } from "./trace-stages.js";
import { recordTaskTrace } from "./task-trace.js";
import type { DurableTaskRequest } from "./durable-task-runner.js";
import {
  durableTaskView,
  taskPollIntervalMs,
  type DurableTaskState,
  type DurableTaskView,
} from "./durable-task-model.js";
import type { ProcessSnapshot, StartCommandInput } from "./process-sessions.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_CHARACTERS = 40_000;
const TASK_HEARTBEAT_STALE_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
const ORPHAN_SWEEP_CONCURRENCY = 16;
const DEFAULT_NOTIFICATION_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface DurableTaskLauncherInput {
  requestPath: string;
  unitName: string;
  runnerPath: string;
}

export interface DurableTaskManagerOptions {
  runRoot?: string;
  runnerPath?: string;
  launchTask?: (input: DurableTaskLauncherInput) => Promise<void>;
  systemdAvailable?: () => boolean;
  stopSystemdUnit?: (unitName: string) => Promise<void>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

type DurableStartCommandInput = StartCommandInput & {
  requestId?: string;
};

export interface DurableTaskNotification {
  taskId: string;
  runId: string;
  status: "completed" | "cancelled" | "failed";
  statusMessage?: string;
  lastUpdatedAt: string;
}

interface DurableTaskActiveMarker {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  root: string;
  taskPath: string;
}

function taskEnvironment(input: StartCommandInput): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    DEVSPACE_WORKSPACE_ID: input.workspaceId,
    DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot ?? input.cwd,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function runIdFor(now: Date): string {
  return `run_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function taskIdFor(): string {
  return `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function taskTtlMs(): number {
  const parsed = Number.parseInt(process.env.DEVSPACE_COMPACT_LOG_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  return days * DAY_MS;
}

function notificationTtlMs(status: DurableTaskNotification["status"]): number {
  if (status === "failed") return taskTtlMs();
  const parsed = Number.parseInt(process.env.DEVSPACE_TASK_NOTIFICATION_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NOTIFICATION_RETENTION_DAYS;
  return days * DAY_MS;
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
}

function systemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const result = spawnSync("systemctl", ["--user", "show-environment"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 1_500,
  });
  return !result.error && result.status === 0;
}

async function readPreview(filePath: string, maxCharacters = DEFAULT_PREVIEW_CHARACTERS): Promise<{
  output: string;
  truncated: boolean;
}> {
  const info = await stat(filePath);
  if (info.size === 0) return { output: "", truncated: false };
  const maxBytes = Math.max(1_024, maxCharacters * 2);
  if (info.size <= maxBytes) {
    return { output: await readFile(filePath, "utf8"), truncated: false };
  }

  const half = Math.floor(maxBytes / 2);
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headRead = await handle.read(head, 0, half, 0);
    const tailRead = await handle.read(tail, 0, half, Math.max(0, info.size - half));
    return {
      output: `${head.subarray(0, headRead.bytesRead).toString("utf8")}\n... output truncated ...\n${tail.subarray(0, tailRead.bytesRead).toString("utf8")}`,
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

async function readState(taskPath: string): Promise<DurableTaskState> {
  return JSON.parse(await readFile(taskPath, "utf8")) as DurableTaskState;
}

function activeTaskState(state: DurableTaskState): boolean {
  return state.status === "working" || state.status === "input_required";
}

export class DurableTaskManager {
  readonly available: boolean;
  private readonly runRoot: string;
  private readonly runnerPath: string;
  private readonly launchOverride?: DurableTaskManagerOptions["launchTask"];
  private readonly orphanSweepAt = new Map<string, number>();
  private readonly systemdAvailable: () => boolean;
  private readonly stopSystemdUnit: (unitName: string) => Promise<void>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;

  constructor(options: DurableTaskManagerOptions = {}) {
    this.runRoot = options.runRoot ?? runStoreRoot();
    this.runnerPath = options.runnerPath
      ?? fileURLToPath(new URL("./durable-task-runner.js", import.meta.url));
    this.launchOverride = options.launchTask;
    this.systemdAvailable = options.systemdAvailable ?? systemdUserAvailable;
    this.stopSystemdUnit = options.stopSystemdUnit ?? (async (unitName) => {
      await execFileAsync("systemctl", ["--user", "stop", unitName], {
        timeout: 5_000,
        windowsHide: true,
      });
    });
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.available = Boolean(this.launchOverride) || existsSync(this.runnerPath);
  }

  async start(input: DurableStartCommandInput, waitMs: number): Promise<ProcessSnapshot> {
    if (!this.available) throw new Error("Durable task runner is unavailable in this build.");
    if (input.requestId) {
      const existing = await this.findTaskByRequestId(
        input.workspaceRoot ?? input.cwd,
        input.requestId,
      );
      if (existing) {
        return this.snapshot(await this.reconcileTask(existing));
      }
    }
    const now = new Date();
    const runId = runIdFor(now);
    const runDir = path.join(this.runRoot, now.toISOString().slice(0, 10), runId);
    const outputPath = path.join(runDir, "output.log");
    const taskPath = path.join(runDir, "task.json");
    const metaPath = path.join(runDir, "meta.json");
    const requestPath = path.join(runDir, "request.json");
    const taskId = taskIdFor();
    const unitName = `devspace-task-${runId}`;
    const indexPath = this.taskIndexPath(taskId);
    const workspaceRoot = input.workspaceRoot ?? input.cwd;
    const notificationPath = this.notificationPath(workspaceRoot, taskId);
    const activePath = this.activePath(workspaceRoot, taskId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(notificationPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(activePath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, "", { mode: 0o600 });
    const startedAt = now.toISOString();
    await writeJsonAtomic(taskPath, {
      schemaVersion: 2,
      taskId,
      status: "working",
      statusMessage: "Task created; command launch pending.",
      createdAt: startedAt,
      lastUpdatedAt: startedAt,
      ttlMs: taskTtlMs(),
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      runId,
      command: input.command,
      cwd: input.cwd,
      root: workspaceRoot,
      outputPath,
      lastActivityAt: startedAt,
      unitName,
      outputBytes: 0,
      outputLines: 0,
    } satisfies DurableTaskState);

    const request: DurableTaskRequest = {
      schemaVersion: 2,
      taskId,
      runId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      unitName,
      command: input.command,
      cwd: input.cwd,
      root: workspaceRoot,
      runRoot: this.runRoot,
      outputPath,
      taskPath,
      metaPath,
      notificationPath,
      activePath,
      startedAt,
      ttlMs: taskTtlMs(),
      env: taskEnvironment(input),
      trace: (() => {
        const context = currentRequestLogContext();
        return { requestId: context?.requestId, traceId: context?.traceId ?? context?.requestId,
          otelTraceId: context?.otelTraceId, otelSpanId: context?.otelSpanId, otelParentSpanId: context?.otelParentSpanId,
          callId: context?.callId, nodeRequestId: context?.nodeRequestId, workspaceId: input.workspaceId };
      })(),
    };
    traceEvent("task_created", { workspaceId: input.workspaceId, taskId, runId });
    recordTaskTrace(runDir, "task_created", { ...request.trace, taskId, runId });
    await writeJsonAtomic(requestPath, request);
    await writeJsonAtomic(indexPath, {
      schemaVersion: 1,
      taskId,
      workspaceId: input.workspaceId,
      runId,
      root: workspaceRoot,
      taskPath,
    });
    if (input.requestId) {
      const requestIndexPath = this.requestIndexPath(input.requestId);
      await mkdir(path.dirname(requestIndexPath), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(requestIndexPath, {
        schemaVersion: 1,
        requestId: input.requestId,
        taskId,
        root: workspaceRoot,
        taskPath,
      });
    }
    await writeJsonAtomic(activePath, {
      schemaVersion: 1,
      taskId,
      runId,
      root: workspaceRoot,
      taskPath,
    } satisfies DurableTaskActiveMarker);

    try {
      await traceStage("task_launch", () => this.launch({ requestPath, unitName, runnerPath: this.runnerPath }), { taskId, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date().toISOString();
      recordTaskTrace(runDir, "task_finished", { ...request.trace, taskId, runId, outcome: "error", errorCategory: "internal", exitCode: 1 });
      const output = `Task launch failed: ${message}\n`;
      await writeFile(outputPath, output, { flag: "a", mode: 0o600 }).catch(() => undefined);
      const failed = {
        ...(await readState(taskPath)),
        status: "failed" as const,
        statusMessage: "Task runner could not be launched.",
        lastUpdatedAt: finishedAt,
        finishedAt,
        exitCode: 1,
        signal: null,
        outputBytes: Buffer.byteLength(output, "utf8"),
        outputLines: 1,
        error: {
          code: -32603,
          message: `Task launch failed: ${message}`,
          data: { runId },
        },
      } satisfies DurableTaskState;
      await writeJsonAtomic(taskPath, failed);
      await writeJsonAtomic(notificationPath, {
        schemaVersion: 1,
        taskId,
        root: workspaceRoot,
        runId,
        status: "failed",
        statusMessage: failed.statusMessage,
        lastUpdatedAt: finishedAt,
      });
      await unlink(activePath).catch(() => undefined);
      return this.snapshot(failed);
    }
    return traceStage("task_initial_wait", async () => {
    const deadline = Date.now() + Math.max(0, waitMs);
    let state = await readState(taskPath);
    while (state.status === "working" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      state = await readState(taskPath);
    }
    return this.snapshot(state);
    }, { taskId, runId });
  }

  async get(
    workspaceRoot: string,
    taskId: string,
    options: { acknowledge?: boolean } = {},
  ): Promise<DurableTaskView> {
    let state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    state = await this.reconcileTask(state);
    const view = durableTaskView(state);
    if (options.acknowledge !== false
      && (view.status === "completed" || view.status === "cancelled" || view.status === "failed")) {
      await unlink(this.notificationPath(workspaceRoot, taskId)).catch(() => undefined);
    }
    return view;
  }

  /** Observe an out-of-process durable runner's atomic task.json renames.
   * Events are only a latency optimisation; every caller must retain timed
   * state checks because fs.watch is not a durable event journal. */
  async watchChanges(workspaceRoot: string, taskId: string, onChange: () => void): Promise<() => void> {
    const state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    const taskPath = await this.findTaskPath(taskId);
    try {
      let pending: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(path.dirname(taskPath), { persistent: false }, (_event, filename) => {
        if ((filename === null || String(filename) === path.basename(taskPath)) && !pending) {
          // Coalesce rapid atomic writes from chatty commands rather than
          // turning each output chunk into an eager status read.
          pending = setTimeout(() => { pending = undefined; onChange(); }, 70);
          pending.unref?.();
        }
      });
      watcher.on("error", () => { onChange(); watcher.close(); });
      return () => { if (pending) clearTimeout(pending); watcher.close(); };
    } catch {
      // Unsupported filesystems use bounded, jittered fallback state reads.
      return () => undefined;
    }
  }

  async pendingNotifications(workspaceRoot: string): Promise<DurableTaskNotification[]> {
    await this.reconcileActiveTasks(workspaceRoot);
    await this.reconcileOrphanedIndexedTasks(workspaceRoot);
    const directory = path.join(this.runRoot, ".task-notifications", workspaceKey(workspaceRoot));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const notifications: DurableTaskNotification[] = [];
    for (const entry of entries.filter((candidate) => candidate.isFile())) {
      const notificationPath = path.join(directory, entry.name);
      try {
        const parsed = JSON.parse(await readFile(notificationPath, "utf8")) as DurableTaskNotification & { root?: string };
        if (parsed.root && path.resolve(parsed.root) !== path.resolve(workspaceRoot)) continue;
        if (parsed.status !== "completed" && parsed.status !== "cancelled" && parsed.status !== "failed") continue;
        const updatedAt = Date.parse(parsed.lastUpdatedAt);
        if (
          Number.isFinite(updatedAt)
          && Date.now() - updatedAt > notificationTtlMs(parsed.status)
        ) {
          await unlink(notificationPath).catch(() => undefined);
          continue;
        }
        notifications.push(parsed);
      } catch {
        // Ignore a partially-written or stale notification file.
      }
    }
    return notifications.sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
  }

  /** Active handles are separate from terminal, unacknowledged notifications. */
  async activeTaskHandles(workspaceRoot: string): Promise<Array<{ taskId: string; status: "working" | "input_required" }>> {
    await this.reconcileActiveTasks(workspaceRoot);
    await this.reconcileOrphanedIndexedTasks(workspaceRoot);
    const directory = path.join(this.runRoot, ".task-active", workspaceKey(workspaceRoot));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const active: Array<{ taskId: string; status: "working" | "input_required" }> = [];
    for (const entry of entries.filter((candidate) => candidate.isFile()).slice(0, 100)) {
      try {
        const marker = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as DurableTaskActiveMarker;
        if (path.resolve(marker.root) !== path.resolve(workspaceRoot)) continue;
        const state = await readState(this.validateTaskPath(marker.taskPath));
        if (state.taskId !== marker.taskId || path.resolve(state.root) !== path.resolve(workspaceRoot)) continue;
        if (state.status === "working" || state.status === "input_required") {
          active.push({ taskId: state.taskId, status: state.status });
        }
      } catch { /* Ignore concurrent completion or malformed markers. */ }
    }
    return active;
  }

  async cancel(workspaceRoot: string, taskId: string): Promise<void> {
    const state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    if (state.status !== "working" && state.status !== "input_required") return;
    const taskPath = await this.findTaskPath(taskId);
    await writeFile(this.cancelPath(taskPath), `${new Date().toISOString()}\n`, { mode: 0o600 });
    if (state.unitName && this.systemdAvailable()) {
      try {
        await this.stopSystemdUnit(state.unitName);
        return;
      } catch {
        // A task can retain its intended unit name after systemd-run falls
        // back to the detached runner. Continue with PID cancellation.
      }
    }
    if (state.runnerPid) {
      if (process.platform !== "win32") {
        try {
          this.killProcess(-state.runnerPid, "SIGTERM");
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      try {
        this.killProcess(state.runnerPid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  async update(
    workspaceRoot: string,
    taskId: string,
    _inputResponses: Record<string, unknown>,
  ): Promise<void> {
    const state = await this.findTask(taskId);
    this.assertOwned(state, workspaceRoot);
    if (state.status !== "input_required") {
      throw new Error(`Task ${taskId} is not waiting for input.`);
    }
    throw new Error(
      "Durable shell tasks do not support input_required resumption in this build; "
      + "the runner has no structured input channel. Inspect or cancel the task instead.",
    );
  }

  private async launch(input: DurableTaskLauncherInput): Promise<void> {
    if (this.launchOverride) {
      await this.launchOverride(input);
      return;
    }

    if (systemdUserAvailable()) {
      try {
        await execFileAsync("systemd-run", [
          "--user",
          "--collect",
          `--unit=${input.unitName}`,
          "--property=Type=exec",
          "--property=KillMode=control-group",
          "--property=TimeoutStopSec=10s",
          process.execPath,
          input.runnerPath,
          input.requestPath,
        ], { timeout: 5_000, windowsHide: true });
        return;
      } catch {
        // Fall through to a detached runner. This keeps Synrex functional on
        // systems without a usable user systemd manager.
      }
    }

    const child = spawn(process.execPath, [input.runnerPath, input.requestPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private async findTask(taskId: string): Promise<DurableTaskState> {
    if (!/^task_(?:[0-9a-f]{16}|[0-9a-f-]{36})$/i.test(taskId)) throw new Error("Invalid taskId.");
    try {
      const pointer = JSON.parse(await readFile(this.taskIndexPath(taskId), "utf8")) as { taskPath?: string };
      if (pointer.taskPath) return readState(this.validateTaskPath(pointer.taskPath));
    } catch {
      // Fall back to scanning runs created before the task index existed.
    }
    const days = await readdir(this.runRoot, { withFileTypes: true }).catch(() => []);
    for (const day of days.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const dayPath = path.join(this.runRoot, day.name);
      const runs = await readdir(dayPath, { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const taskPath = path.join(dayPath, run.name, "task.json");
        try {
          const state = await readState(taskPath);
          if (state.taskId === taskId) return state;
        } catch {
          // Ignore non-task or partially-created run directories.
        }
      }
    }
    throw new Error(`Unknown task: ${taskId}`);
  }

  private async findTaskByRequestId(
    workspaceRoot: string,
    requestId: string,
  ): Promise<DurableTaskState | undefined> {
    if (!/^nrq_[A-Za-z0-9-]+$/.test(requestId)) return undefined;
    try {
      const pointer = JSON.parse(await readFile(this.requestIndexPath(requestId), "utf8")) as {
        root?: string;
        taskPath?: string;
      };
      if (!pointer.taskPath || !pointer.root) return undefined;
      if (path.resolve(pointer.root) !== path.resolve(workspaceRoot)) {
        throw new Error(`Node request ${requestId} belongs to a different workspace root.`);
      }
      const state = await readState(this.validateTaskPath(pointer.taskPath));
      this.assertOwned(state, workspaceRoot);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private assertOwned(state: DurableTaskState, workspaceRoot: string): void {
    if (path.resolve(state.root) !== path.resolve(workspaceRoot)) {
      throw new Error(`Task ${state.taskId} does not belong to workspace root ${workspaceRoot}.`);
    }
  }

  private async writeTaskState(
    state: DurableTaskState,
    update: Partial<DurableTaskState>,
  ): Promise<void> {
    const next = {
      ...state,
      ...update,
      lastUpdatedAt: new Date().toISOString(),
    } satisfies DurableTaskState;
    const taskPath = await this.findTaskPath(state.taskId);
    await writeJsonAtomic(taskPath, next);
  }

  private async reconcileActiveTasks(workspaceRoot: string): Promise<void> {
    const directory = path.join(this.runRoot, ".task-active", workspaceKey(workspaceRoot));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    let reconciledCount = 0;
    for (const entry of entries.filter((candidate) => candidate.isFile())) {
      const markerPath = path.join(directory, entry.name);
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as DurableTaskActiveMarker;
        if (path.resolve(marker.root) !== path.resolve(workspaceRoot)) {
          await unlink(markerPath).catch(() => undefined);
          continue;
        }
        if (reconciledCount >= 100) continue;
        reconciledCount += 1;
        const state = await readState(this.validateTaskPath(marker.taskPath));
        const reconciled = await this.reconcileTask(state);
        if (reconciled.status !== "working" && reconciled.status !== "input_required") {
          await unlink(markerPath).catch(() => undefined);
        }
      } catch {
        await unlink(markerPath).catch(() => undefined);
      }
    }
  }

  private async reconcileOrphanedIndexedTasks(workspaceRoot: string): Promise<void> {
    const key = workspaceKey(workspaceRoot);
    const now = Date.now();
    const previous = this.orphanSweepAt.get(key) ?? 0;
    if (now - previous < ORPHAN_SWEEP_INTERVAL_MS) return;
    this.orphanSweepAt.set(key, now);

    const directory = path.join(this.runRoot, ".task-index");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((candidate) => candidate.isFile());
    let cursor = 0;
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const entry = files[cursor++];
        if (!entry) return;
        const indexPath = path.join(directory, entry.name);
        try {
          const pointer = JSON.parse(
            await readFile(indexPath, "utf8"),
          ) as Record<string, unknown> & { taskPath?: string; root?: string };
          if (pointer.root && path.resolve(pointer.root) !== resolvedWorkspaceRoot) continue;
          if (!pointer.taskPath) continue;
          const taskPath = this.validateTaskPath(pointer.taskPath);
          const state = await readState(taskPath);
          const stateRoot = path.resolve(state.root);
          if (!pointer.root) {
            // Older task indexes predate the root field. Backfill it once so
            // future workspace sweeps can reject unrelated tasks without an
            // extra task.json read.
            await writeJsonAtomic(indexPath, { ...pointer, root: state.root }).catch(() => undefined);
          }
          if (stateRoot !== resolvedWorkspaceRoot) continue;
          if (state.status !== "working" && state.status !== "input_required") continue;
          const reconciled = await this.reconcileTask(state);
          if (reconciled.status === "working" || reconciled.status === "input_required") {
            await writeJsonAtomic(this.activePath(workspaceRoot, state.taskId), {
              schemaVersion: 1,
              taskId: state.taskId,
              runId: state.runId,
              root: workspaceRoot,
              taskPath,
            } satisfies DurableTaskActiveMarker);
          }
        } catch {
          // One corrupt historical index entry must not block recovery of others.
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ORPHAN_SWEEP_CONCURRENCY, Math.max(1, files.length)) },
        () => worker(),
      ),
    );
  }

  private async reconcileTask(state: DurableTaskState): Promise<DurableTaskState> {
    if (state.status !== "working" && state.status !== "input_required") return state;
    if (await this.runnerIsAlive(state)) return state;

    const finishedAt = new Date().toISOString();
    const taskPath = await this.findTaskPath(state.taskId);
    const cancelRequested = existsSync(this.cancelPath(taskPath));
    const message = cancelRequested
      ? "Task cancelled before the runner wrote a terminal task state."
      : "Task runner exited without writing a terminal task state.";
    const terminal = {
      ...state,
      status: cancelRequested ? "cancelled" as const : "failed" as const,
      statusMessage: message,
      lastUpdatedAt: finishedAt,
      finishedAt,
      ...(cancelRequested
        ? { signal: "SIGTERM" as const, error: undefined }
        : {
            error: {
              code: -32603,
              message,
              data: { runId: state.runId },
            },
          }),
    } satisfies DurableTaskState;
    await writeJsonAtomic(taskPath, terminal);
    const notificationPath = this.notificationPath(state.root, state.taskId);
    await mkdir(path.dirname(notificationPath), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(notificationPath, {
      schemaVersion: 1,
      taskId: state.taskId,
      root: state.root,
      runId: state.runId,
      status: terminal.status,
      statusMessage: message,
      lastUpdatedAt: finishedAt,
    });
    await unlink(this.activePath(state.root, state.taskId)).catch(() => undefined);
    return terminal;
  }

  private async runnerIsAlive(state: DurableTaskState): Promise<boolean> {
    let unitKnownInactive = false;
    if (!this.launchOverride && state.unitName && this.systemdAvailable()) {
      try {
        const { stdout } = await execFileAsync(
          "systemctl",
          ["--user", "show", state.unitName, "--property=ActiveState", "--value"],
          { timeout: 1_500, windowsHide: true },
        );
        const activeState = stdout.trim();
        if (activeState === "active" || activeState === "activating" || activeState === "reloading" || activeState === "deactivating") {
          return true;
        }
        unitKnownInactive = true;
      } catch {
        // A user-manager restart or transient systemctl failure is not proof
        // that the runner died. Fall through to the runner PID/heartbeat.
      }
    }

    if (state.runnerPid) {
      try {
        process.kill(state.runnerPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        return false;
      }
      if (process.platform === "linux" && !this.launchOverride) {
        try {
          const commandLine = await readFile(`/proc/${state.runnerPid}/cmdline`, "utf8");
          if (!commandLine.includes(state.runId)) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        }
      }
      return true;
    }

    if (unitKnownInactive) return false;

    const updatedAt = Date.parse(state.lastUpdatedAt);
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt <= TASK_HEARTBEAT_STALE_MS;
  }

  private async findTaskPath(taskId: string): Promise<string> {
    try {
      const pointer = JSON.parse(await readFile(this.taskIndexPath(taskId), "utf8")) as { taskPath?: string };
      if (pointer.taskPath) return this.validateTaskPath(pointer.taskPath);
    } catch {
      // Fall through to the compatibility scan.
    }
    const days = await readdir(this.runRoot, { withFileTypes: true }).catch(() => []);
    for (const day of days.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const dayPath = path.join(this.runRoot, day.name);
      const runs = await readdir(dayPath, { withFileTypes: true }).catch(() => []);
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const taskPath = path.join(dayPath, run.name, "task.json");
        try {
          const state = await readState(taskPath);
          if (state.taskId === taskId) return taskPath;
        } catch {
          // Ignore non-task or partially-written run directories.
        }
      }
    }
    throw new Error(`Unknown task: ${taskId}`);
  }

  private taskIndexPath(taskId: string): string {
    return path.join(this.runRoot, ".task-index", `${taskId}.json`);
  }

  private requestIndexPath(requestId: string): string {
    return path.join(this.runRoot, ".node-request-index", `${requestId}.json`);
  }

  private cancelPath(taskPath: string): string {
    return path.join(path.dirname(taskPath), "cancel.requested");
  }

  private notificationPath(workspaceRoot: string, taskId: string): string {
    return path.join(
      this.runRoot,
      ".task-notifications",
      workspaceKey(workspaceRoot),
      `${taskId}.json`,
    );
  }

  private activePath(workspaceRoot: string, taskId: string): string {
    return path.join(
      this.runRoot,
      ".task-active",
      workspaceKey(workspaceRoot),
      `${taskId}.json`,
    );
  }

  private validateTaskPath(candidate: string): string {
    const resolvedRoot = path.resolve(this.runRoot);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Task index points outside the run store.");
    }
    return resolved;
  }

  private async snapshot(state: DurableTaskState): Promise<ProcessSnapshot> {
    const preview = await readPreview(state.outputPath);
    const startedAt = Date.parse(state.createdAt);
    const lastActivityAt = Date.parse(state.lastActivityAt);
    const now = Date.now();
    // Heartbeat freshness is recovery evidence, not the public task state.
    // A nonterminal task remains active until reconciliation commits a
    // terminal transition; otherwise a transient heartbeat write failure can
    // make exec_command report running=false while task_get still reports
    // working/input_required.
    const running = activeTaskState(state);
    return {
      runId: state.runId,
      taskId: state.taskId,
      command: state.command,
      output: preview.output,
      outputBytes: state.outputBytes,
      outputLines: state.outputLines,
      outputTruncated: preview.truncated,
      running,
      exitCode: state.exitCode ?? undefined,
      signal: state.signal ?? undefined,
      wallTimeMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0,
      idleTimeMs: Number.isFinite(lastActivityAt) ? Math.max(0, now - lastActivityAt) : 0,
    };
  }
}
