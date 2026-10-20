import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handleRunLogCommand } from "./compact-runtime/run-log-access.js";
import { runDurableTask, type DurableTaskRequest } from "./durable-task-runner.js";
import { DurableTaskManager } from "./durable-tasks.js";

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

test("durable task runner persists output and terminal metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-runner-"));
  try {
    const runId = "run_20260914120000_runner";
    const runDir = path.join(root, "2026-09-14", runId);
    await mkdir(runDir, { recursive: true });
    const requestPath = path.join(runDir, "request.json");
    const request: DurableTaskRequest = {
      schemaVersion: 2,
      taskId: "task_11111111-1111-4111-8111-111111111111",
      runId,
      workspaceId: "workspace-a",
      command: `${node} -e "console.log('durable-runner-ok')"`,
      cwd: process.cwd(),
      root: process.cwd(),
      runRoot: root,
      outputPath: path.join(runDir, "output.log"),
      taskPath: path.join(runDir, "task.json"),
      metaPath: path.join(runDir, "meta.json"),
      notificationPath: path.join(runDir, "notification.json"),
      activePath: path.join(runDir, "active.json"),
      startedAt: new Date().toISOString(),
      ttlMs: 30 * 24 * 60 * 60 * 1_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    };
    await writeFile(request.outputPath, "", { mode: 0o600 });
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });

    const exitCode = await runDurableTask(requestPath);
    assert.equal(exitCode, 0);
    assert.match(await readFile(request.outputPath, "utf8"), /durable-runner-ok/);
    const task = JSON.parse(await readFile(request.taskPath, "utf8")) as {
      status: string;
      outputLines: number;
      result?: { isError?: boolean };
    };
    assert.equal(task.status, "completed");
    assert.equal(task.outputLines, 1);
    assert.equal(task.result?.isError, false);
    const meta = JSON.parse(await readFile(request.metaPath, "utf8")) as { exitCode: number; isError: boolean };
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.isError, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable task manager returns promptly and run logs become queryable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-manager-"));
  const previousRoot = process.env.DEVSPACE_COMPACT_RUN_ROOT;
  process.env.DEVSPACE_COMPACT_RUN_ROOT = root;
  let runner: Promise<number> | undefined;
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        runner = runDurableTask(requestPath);
      },
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-a",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "console.log('durable-start'); setTimeout(() => console.log('durable-done'), 120)"`,
    }, 5);

    assert.equal(snapshot.running, true);
    assert.equal(snapshot.sessionId, undefined);
    assert.match(snapshot.taskId ?? "", /^task_[0-9a-f]{16}$/i);
    assert.match(snapshot.runId, /^run_/);

    const working = await manager.get(process.cwd(), snapshot.taskId as string);
    assert.equal(working.status, "working");
    assert.ok((working.pollIntervalMs ?? 0) > 0);

    assert.ok(runner);
    assert.equal(await runner, 0);
    const meta = JSON.parse(await handleRunLogCommand(`devspace-log meta ${snapshot.runId}`) as string) as {
      exitCode: number;
      isError: boolean;
    };
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.isError, false);
    const completed = await manager.get(process.cwd(), snapshot.taskId as string);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result?.isError, false);
    assert.equal(completed.result?.exitCode, 0);
    const output = await handleRunLogCommand(`devspace-log read ${snapshot.runId} 1 20`);
    assert.match(output as string, /durable-start/);
    assert.match(output as string, /durable-done/);
  } finally {
    await runner?.catch(() => undefined);
    if (previousRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
    else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("nonzero command is a completed task with an error tool result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-nonzero-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        void runDurableTask(requestPath);
      },
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-a",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "process.exit(7)"`,
    }, 250);
    assert.ok(snapshot.taskId);
    const task = await manager.get(process.cwd(), snapshot.taskId);
    assert.equal(task.status, "completed");
    assert.equal(task.result?.isError, true);
    assert.equal(task.result?.exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task ownership is enforced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-owner-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        void runDurableTask(requestPath);
      },
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-a",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 50)"`,
    }, 5);
    assert.ok(snapshot.taskId);
    await assert.rejects(
      manager.get(path.join(process.cwd(), "different-root"), snapshot.taskId),
      /does not belong to workspace/,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const task = await manager.get(process.cwd(), snapshot.taskId);
      if (task.status !== "working") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal tasks persist a completion notification until task_get acknowledges it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-notify-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        void runDurableTask(requestPath);
      },
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-a",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "console.log('notify-done')"`,
    }, 250);
    assert.ok(snapshot.taskId);

    const pending = await manager.pendingNotifications(process.cwd());
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.taskId, snapshot.taskId);
    assert.equal(pending[0]?.status, "completed");

    const task = await manager.get(process.cwd(), snapshot.taskId);
    assert.equal(task.status, "completed");
    assert.deepEqual(await manager.pendingNotifications(process.cwd()), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale task whose runner disappeared is reconciled to failed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-stale-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-stale",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "sleep 60",
    }, 0);
    assert.ok(snapshot.taskId);
    const indexPath = path.join(root, ".task-index", `${snapshot.taskId}.json`);
    const pointer = JSON.parse(await readFile(indexPath, "utf8")) as { taskPath: string };
    const state = JSON.parse(await readFile(pointer.taskPath, "utf8")) as Record<string, unknown>;
    state.lastUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(pointer.taskPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    const view = await manager.get(workspaceRoot, snapshot.taskId, { acknowledge: false });
    assert.equal(view.status, "failed");
    assert.match(view.error?.message ?? "", /runner exited/i);
    const pending = await manager.pendingNotifications(workspaceRoot);
    assert.ok(pending.some((item) => item.taskId === snapshot.taskId && item.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel falls back to the runner PID when systemd stop fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-cancel-fallback-"));
  const stoppedUnits: string[] = [];
  const killed: number[] = [];
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
      systemdAvailable: () => true,
      stopSystemdUnit: async (unitName) => {
        stoppedUnits.push(unitName);
        throw new Error("unit not found");
      },
      killProcess: (pid) => {
        killed.push(pid);
      },
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-cancel",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "sleep 60",
    }, 0);
    assert.ok(snapshot.taskId);
    const indexPath = path.join(root, ".task-index", `${snapshot.taskId}.json`);
    const pointer = JSON.parse(await readFile(indexPath, "utf8")) as { taskPath: string };
    const state = JSON.parse(await readFile(pointer.taskPath, "utf8")) as Record<string, unknown>;
    state.runnerPid = 4242;
    state.unitName = "devspace-task-missing";
    await writeFile(pointer.taskPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    await manager.cancel(workspaceRoot, snapshot.taskId);
    assert.deepEqual(stoppedUnits, ["devspace-task-missing"]);
    assert.deepEqual(killed, [process.platform === "win32" ? 4242 : -4242]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead input_required task reconciles to failed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-input-stale-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-input-stale",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "fake",
    }, 0);
    assert.ok(snapshot.taskId);
    const indexPath = path.join(root, ".task-index", `${snapshot.taskId}.json`);
    const pointer = JSON.parse(await readFile(indexPath, "utf8")) as { taskPath: string };
    const state = JSON.parse(await readFile(pointer.taskPath, "utf8")) as Record<string, unknown>;
    state.status = "input_required";
    state.statusMessage = "Waiting for input.";
    state.inputRequests = { answer: { prompt: "continue?" } };
    state.lastUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(pointer.taskPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    const view = await manager.get(workspaceRoot, snapshot.taskId, { acknowledge: false });
    assert.equal(view.status, "failed");
    assert.match(view.error?.message ?? "", /runner exited/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task snapshots do not turn stale nonterminal state into a false terminal result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-snapshot-state-"));
  try {
    const outputPath = path.join(root, "output.log");
    await writeFile(outputPath, "");
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const base = {
      schemaVersion: 2 as const,
      taskId: "task_7878787878787878",
      status: "working" as const,
      createdAt: old,
      lastUpdatedAt: old,
      ttlMs: 60_000,
      workspaceId: "workspace-snapshot-state",
      runId: "run_20261001000000_snapshot_state",
      command: "fake",
      cwd: process.cwd(),
      root: process.cwd(),
      outputPath,
      lastActivityAt: old,
      outputBytes: 0,
      outputLines: 0,
    };
    const snapshotState = (manager as unknown as {
      snapshot(state: Record<string, unknown>): Promise<{ running: boolean }>;
    }).snapshot.bind(manager);
    const snapshot = await snapshotState(base);
    assert.equal(snapshot.running, true);
    const inputRequired = await snapshotState({ ...base, status: "input_required" });
    assert.equal(inputRequired.running, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphaned nonterminal tasks are recovered even when the active marker is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-orphan-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-orphan",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "fake",
    }, 0);
    assert.ok(snapshot.taskId);
    const indexPath = path.join(root, ".task-index", `${snapshot.taskId}.json`);
    const pointer = JSON.parse(await readFile(indexPath, "utf8")) as { taskPath: string };
    const state = JSON.parse(await readFile(pointer.taskPath, "utf8")) as Record<string, unknown>;
    state.lastUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(pointer.taskPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const workspaceHash = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
    await unlink(path.join(root, ".task-active", workspaceHash, `${snapshot.taskId}.json`));

    const pending = await manager.pendingNotifications(workspaceRoot);
    assert.ok(pending.some((item) => item.taskId === snapshot.taskId && item.status === "failed"));
    const view = await manager.get(workspaceRoot, snapshot.taskId, { acknowledge: false });
    assert.equal(view.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan recovery backfills the workspace root into legacy task indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-index-root-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-index-root",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "fake",
    }, 0);
    assert.ok(snapshot.taskId);
    const indexPath = path.join(root, ".task-index", `${snapshot.taskId}.json`);
    const pointer = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    delete pointer.root;
    await writeFile(indexPath, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });
    const taskPointer = pointer.taskPath as string;
    const state = JSON.parse(await readFile(taskPointer, "utf8")) as Record<string, unknown>;
    state.lastUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(taskPointer, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    await manager.pendingNotifications(workspaceRoot);
    const repaired = JSON.parse(await readFile(indexPath, "utf8")) as { root?: string };
    assert.equal(repaired.root, workspaceRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt active markers cannot starve a later valid recovery marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-active-cap-"));
  try {
    const workspaceRoot = await mkdtemp(path.join(root, "workspace-"));
    const workspaceHash = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
    const activeDir = path.join(root, ".task-active", workspaceHash);
    const indexDir = path.join(root, ".task-index");
    const runId = "run_20261001000000_activecap";
    const taskId = "task_dddddddddddddddd";
    const runDir = path.join(root, "2026-10-01", runId);
    const taskPath = path.join(runDir, "task.json");
    await mkdir(activeDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(activeDir, `a${String(index).padStart(3, "0")}.json`), "{broken");
    }
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(taskPath, `${JSON.stringify({
      schemaVersion: 2,
      taskId,
      status: "working",
      createdAt: old,
      lastUpdatedAt: old,
      ttlMs: 60_000,
      workspaceId: "workspace-active-cap",
      runId,
      command: "fake",
      cwd: workspaceRoot,
      root: workspaceRoot,
      outputPath: path.join(runDir, "output.log"),
      lastActivityAt: old,
      outputBytes: 0,
      outputLines: 0,
    }, null, 2)}\n`);
    await writeFile(path.join(activeDir, "z-valid.json"), `${JSON.stringify({
      schemaVersion: 1,
      taskId,
      runId,
      root: workspaceRoot,
      taskPath,
    })}\n`);

    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const pending = await manager.pendingNotifications(workspaceRoot);
    assert.ok(pending.some((item) => item.taskId === taskId && item.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending notifications prefer newest terminal work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-notify-order-"));
  try {
    const workspaceRoot = process.cwd();
    const workspaceHash = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
    const notificationDir = path.join(root, ".task-notifications", workspaceHash);
    await mkdir(notificationDir, { recursive: true });
    const older = {
      schemaVersion: 1,
      taskId: "task_eeeeeeeeeeeeeeee",
      root: workspaceRoot,
      runId: "run_old",
      status: "completed",
      lastUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const newer = {
      ...older,
      taskId: "task_ffffffffffffffff",
      runId: "run_new",
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeFile(path.join(notificationDir, "old.json"), JSON.stringify(older));
    await writeFile(path.join(notificationDir, "new.json"), JSON.stringify(newer));
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    const pending = await manager.pendingNotifications(workspaceRoot);
    assert.deepEqual(pending.map((item) => item.taskId), [newer.taskId, older.taskId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old successful notifications expire without deleting durable run history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-notify-retention-"));
  try {
    const workspaceRoot = process.cwd();
    const workspaceHash = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
    const notificationDir = path.join(root, ".task-notifications", workspaceHash);
    await mkdir(notificationDir, { recursive: true });
    const oldTaskId = "task_abababababababab";
    const oldNotification = {
      schemaVersion: 1,
      taskId: oldTaskId,
      root: workspaceRoot,
      runId: "run_old_notification",
      status: "completed",
      lastUpdatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    const oldPath = path.join(notificationDir, `${oldTaskId}.json`);
    await writeFile(oldPath, JSON.stringify(oldNotification));
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => undefined,
    });
    assert.deepEqual(await manager.pendingNotifications(workspaceRoot), []);
    await assert.rejects(() => readFile(oldPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient task-state write failure does not poison the terminal write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-write-recovery-"));
  try {
    const runId = "run_20261001000000_write_recovery";
    const runDir = path.join(root, "2026-10-01", runId);
    await mkdir(runDir, { recursive: true });
    const requestPath = path.join(runDir, "request.json");
    const request: DurableTaskRequest = {
      schemaVersion: 2,
      taskId: "task_1212121212121212",
      runId,
      workspaceId: "workspace-write-recovery",
      command: `${node} -e "process.exit(0)"`,
      cwd: process.cwd(),
      root: process.cwd(),
      runRoot: root,
      outputPath: path.join(runDir, "output.log"),
      taskPath: path.join(runDir, "task.json"),
      metaPath: path.join(runDir, "meta.json"),
      notificationPath: path.join(runDir, "notification.json"),
      activePath: path.join(runDir, "active.json"),
      startedAt: new Date().toISOString(),
      ttlMs: 60_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    };
    await writeFile(request.outputPath, "", { mode: 0o600 });
    await writeFile(request.taskPath, "{}\n", { mode: 0o600 });
    await writeFile(request.activePath, "{}\n", { mode: 0o600 });
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    let writes = 0;
    const exitCode = await runDurableTask(requestPath, {
      writeTaskState: async (taskPath, value) => {
        writes += 1;
        if (writes === 1) throw new Error("transient write failure");
        await writeFile(taskPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      },
    });
    assert.equal(exitCode, 1);
    const task = JSON.parse(await readFile(request.taskPath, "utf8")) as { status?: string };
    assert.equal(task.status, "failed");
    assert.ok(writes >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node request ids make durable command creation idempotent across manager restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-request-id-"));
  let launches = 0;
  const options = {
    runRoot: root,
    runnerPath: "test-runner",
    launchTask: async () => {
      launches += 1;
    },
  };
  try {
    const requestId = "nrq_22222222-2222-4222-8222-222222222222";
    const workspaceRoot = process.cwd();
    const firstManager = new DurableTaskManager(options);
    const first = await firstManager.start({
      workspaceId: "workspace-request-id",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "side-effecting-command",
      requestId,
    }, 0);
    assert.ok(first.taskId);
    assert.equal(launches, 1);

    const restoredManager = new DurableTaskManager(options);
    const restored = await restoredManager.start({
      workspaceId: "workspace-request-id",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "side-effecting-command",
      requestId,
    }, 0);
    assert.equal(restored.taskId, first.taskId);
    assert.equal(restored.runId, first.runId);
    assert.equal(launches, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable runner persists high-volume output without dropping bytes under backpressure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-output-pressure-"));
  try {
    const runId = "run_20261001000000_output_pressure";
    const runDir = path.join(root, "2026-10-01", runId);
    await mkdir(runDir, { recursive: true });
    const requestPath = path.join(runDir, "request.json");
    const outputPath = path.join(runDir, "output.log");
    const taskPath = path.join(runDir, "task.json");
    const bytes = 4 * 1024 * 1024;
    const request: DurableTaskRequest = {
      schemaVersion: 2,
      taskId: "task_3434343434343434",
      runId,
      workspaceId: "workspace-output-pressure",
      command: `${node} -e "process.stdout.write('x'.repeat(${bytes}))"`,
      cwd: process.cwd(),
      root: process.cwd(),
      runRoot: root,
      outputPath,
      taskPath,
      metaPath: path.join(runDir, "meta.json"),
      notificationPath: path.join(runDir, "notification.json"),
      activePath: path.join(runDir, "active.json"),
      startedAt: new Date().toISOString(),
      ttlMs: 60_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    };
    await writeFile(outputPath, "", { mode: 0o600 });
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const exitCode = await runDurableTask(requestPath);
    assert.equal(exitCode, 0);
    const task = JSON.parse(await readFile(taskPath, "utf8")) as { outputBytes: number; status: string };
    assert.equal(task.status, "completed");
    assert.equal(task.outputBytes, bytes);
    assert.equal((await stat(outputPath)).size, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel before runner PID publication prevents command launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-cancel-prepid-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let runner: Promise<number> | undefined;
  const sideEffect = path.join(root, "side-effect.txt");
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async ({ requestPath }) => {
        runner = (async () => {
          await gate;
          return runDurableTask(requestPath);
        })();
      },
      systemdAvailable: () => false,
    });
    const snapshot = await manager.start({
      workspaceId: "workspace-cancel-prepid",
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      command: `${node} -e "require('fs').writeFileSync(${JSON.stringify(sideEffect)}, 'ran')"`,
    }, 0);
    assert.ok(snapshot.taskId);
    await manager.cancel(process.cwd(), snapshot.taskId);
    release();
    assert.equal(await runner, 143);
    const view = await manager.get(process.cwd(), snapshot.taskId, { acknowledge: false });
    assert.equal(view.status, "cancelled");
    await assert.rejects(() => readFile(sideEffect, "utf8"), /ENOENT/);
  } finally {
    release?.();
    await runner?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused unrelated PID cannot keep a stale task working on Linux", async (t) => {
  if (process.platform !== "linux") {
    t.skip("runner identity check uses Linux /proc");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-pid-identity-"));
  try {
    const workspaceRoot = process.cwd();
    const taskId = "task_5656565656565656";
    const runId = "run_20261001000000_pid_identity";
    const runDir = path.join(root, "2026-10-01", runId);
    const taskPath = path.join(runDir, "task.json");
    const indexDir = path.join(root, ".task-index");
    await mkdir(runDir, { recursive: true });
    await mkdir(indexDir, { recursive: true });
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(taskPath, `${JSON.stringify({
      schemaVersion: 2,
      taskId,
      status: "working",
      createdAt: old,
      lastUpdatedAt: old,
      ttlMs: 60_000,
      workspaceId: "workspace-pid-identity",
      runId,
      command: "fake",
      cwd: workspaceRoot,
      root: workspaceRoot,
      outputPath: path.join(runDir, "output.log"),
      lastActivityAt: old,
      runnerPid: process.pid,
      outputBytes: 0,
      outputLines: 0,
    }, null, 2)}\n`);
    await writeFile(path.join(indexDir, `${taskId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      taskId,
      workspaceId: "workspace-pid-identity",
      runId,
      root: workspaceRoot,
      taskPath,
    })}\n`);
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "production-runner",
      systemdAvailable: () => false,
    });
    const view = await manager.get(workspaceRoot, taskId, { acknowledge: false });
    assert.equal(view.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher failure terminalizes the durable task instead of leaving a working ghost", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-durable-launch-failure-"));
  try {
    const manager = new DurableTaskManager({
      runRoot: root,
      runnerPath: "test-runner",
      launchTask: async () => {
        throw new Error("launch exploded");
      },
    });
    const workspaceRoot = process.cwd();
    const snapshot = await manager.start({
      workspaceId: "workspace-launch-failure",
      workspaceRoot,
      cwd: workspaceRoot,
      command: "never-runs",
    }, 0);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exitCode, 1);
    assert.ok(snapshot.taskId);
    const view = await manager.get(workspaceRoot, snapshot.taskId, { acknowledge: false });
    assert.equal(view.status, "failed");
    assert.match(view.error?.message ?? "", /launch exploded/);
    const pending = await manager.pendingNotifications(workspaceRoot);
    assert.ok(pending.some((item) => item.taskId === snapshot.taskId && item.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
