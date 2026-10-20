import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

interface BenchmarkTask {
  id: string;
  prompt: string;
  evaluate(response: string): boolean;
}

interface BenchmarkRow {
  taskId: string;
  target: string;
  agentId?: string;
  status: string;
  valid: boolean;
  success: boolean;
  wallTimeMs: number;
  response?: string;
  error?: unknown;
}

const root = resolve(".");
const cli = join(root, "dist", "cli.js");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, ".devspace", "benchmarks", "local-operator");
const outFile = join(outDir, `${runId}.jsonl`);
const targets = (process.env.DEVSPACE_BENCHMARK_TARGETS ?? "local-operator,codex")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const unavailableTargets = new Set<string>();

const tasks: BenchmarkTask[] = [
  {
    id: "package-meta",
    prompt: "Inspect package.json and report only: package name, Node engine requirement, and the test script. Do not edit files.",
    evaluate: (response) => [
      "devspace-verge",
      ">=22.19 <27",
      "tsx --test --test-concurrency=1",
    ].every((expected) => response.includes(expected)),
  },
  {
    id: "daemon-constants",
    prompt: "Read src/local-agent-daemon.ts. Report exactly two facts: the default daemon idle shutdown milliseconds and the default request read timeout milliseconds. Do not edit files.",
    evaluate: (response) => {
      const normalized = response.replace(/[,_\s]/g, "");
      return normalized.includes("30000") && normalized.includes("5000");
    },
  },
  {
    id: "multinode-protocol",
    prompt: "Read src/multinode/protocol.ts. Report only the DEVSPACE_NODE_PROTOCOL major and minor values, plus all NodeHealth string values. Do not edit files.",
    evaluate: (response) => {
      const normalized = response.toLowerCase();
      return normalized.includes("major")
        && normalized.includes("minor")
        && /major\D+1/.test(normalized)
        && /minor\D+1/.test(normalized)
        && ["online", "suspect", "offline", "draining"].every((value) => normalized.includes(value));
    },
  },
];

await mkdir(outDir, { recursive: true });
await writeFile(outFile, "");

for (const task of tasks) {
  for (const target of targets) {
    if (unavailableTargets.has(target)) {
      const row: BenchmarkRow = {
        taskId: task.id,
        target,
        status: "provider_unavailable_after_invalid_run",
        valid: false,
        success: false,
        wallTimeMs: 0,
        error: "Skipped after an infrastructure-invalid provider run.",
      };
      await appendFile(outFile, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      continue;
    }
    const row = await runBenchmarkTask(task, target);
    if (!row.valid) unavailableTargets.add(target);
    await appendFile(outFile, `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
  }
}

console.log(JSON.stringify({ output: outFile, summary: summarize(await readRows(outFile)) }));

async function runBenchmarkTask(task: BenchmarkTask, target: string): Promise<BenchmarkRow> {
  const started = performance.now();
  try {
    const launched = await runCli(["agents", "run", target, "--json", task.prompt], 45_000);
    if (launched.code !== 0) {
      const detail = [launched.stdout, launched.stderr].filter(Boolean).join("\n");
      return failureRow(task.id, target, started, "start_failed", detail);
    }
    const receipt = JSON.parse(launched.stdout) as { id: string };
    const deadline = Date.now() + (target === "local-operator"
      ? Number(process.env.DEVSPACE_BENCHMARK_LOCAL_TIMEOUT_MS ?? 90_000)
      : Number(process.env.DEVSPACE_BENCHMARK_CODEX_TIMEOUT_MS ?? 90_000));
    while (Date.now() < deadline) {
      const shown = await runCli(["agents", "show", receipt.id, "--json"], 40_000);
      if (shown.code !== 0) {
        const detail = [shown.stdout, shown.stderr].filter(Boolean).join("\n");
        return failureRow(task.id, target, started, "show_failed", detail, receipt.id);
      }
      const result = JSON.parse(shown.stdout) as {
        status: string;
        response?: string;
        error?: { retryable?: boolean; message?: string; code?: string };
      };
      if (result.status === "starting" || result.status === "running") {
        await delay(500);
        continue;
      }
      const response = result.response ?? "";
      const valid = !isInfrastructureFailure(result.error);
      return {
        taskId: task.id,
        target,
        agentId: receipt.id,
        status: result.status,
        valid,
        success: valid && result.status === "completed" && task.evaluate(response),
        wallTimeMs: Math.round(performance.now() - started),
        ...(response ? { response } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }
    return {
      ...failureRow(task.id, target, started, "timeout", "benchmark deadline exceeded", receipt.id),
      valid: false,
    };
  } catch (error) {
    return failureRow(task.id, target, started, "exception", error instanceof Error ? error.message : String(error));
  }
}

function failureRow(
  taskId: string,
  target: string,
  started: number,
  status: string,
  error: unknown,
  agentId?: string,
): BenchmarkRow {
  return {
    taskId,
    target,
    ...(agentId ? { agentId } : {}),
    status,
    valid: !isInfrastructureFailure(error),
    success: false,
    wallTimeMs: Math.round(performance.now() - started),
    error,
  };
}

function isInfrastructureFailure(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (record.retryable === true) return true;
  }
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return /stream disconnected|connection reset|fetch failed|transport|daemon_unavailable|daemon_timeout|temporarily unavailable|node .*offline/i.test(text);
}

function summarize(rows: BenchmarkRow[]) {
  return targets.map((target) => {
    const attempted = rows.filter((row) => row.target === target);
    const valid = attempted.filter((row) => row.valid);
    const successful = valid.filter((row) => row.success);
    return {
      target,
      attempted: attempted.length,
      invalid: attempted.length - valid.length,
      valid: valid.length,
      successes: successful.length,
      successRate: valid.length ? successful.length / valid.length : null,
      meanWallTimeMs: valid.length
        ? Math.round(valid.reduce((sum, row) => sum + row.wallTimeMs, 0) / valid.length)
        : null,
    };
  });
}

async function readRows(file: string): Promise<BenchmarkRow[]> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkRow);
}

async function runCli(args: string[], timeoutMs: number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref?.();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
