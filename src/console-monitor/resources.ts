import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { entries } from "./files.js";
import type { Execution, ProcessRow, Resources } from "./types.js";

const exec = promisify(execFile);
export const PROCESS_LIMIT = 1024;
export function classifyDiskPressure(availableBytes: number, totalBytes: number): "ok" | "warning" | "critical" {
  if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(totalBytes) ||
      availableBytes < 0 || totalBytes <= 0 || availableBytes > totalBytes) {
    throw new Error("Invalid disk capacity sample");
  }
  if (availableBytes < 2 * 1024 ** 3 || availableBytes / totalBytes < 0.05) return "critical";
  if (availableBytes < 10 * 1024 ** 3 || availableBytes / totalBytes < 0.1) return "warning";
  return "ok";
}
interface Counters { total: number; idle: number }
function counters(): Counters {
  return os.cpus().reduce((a, cpu) => ({ total: a.total + Object.values(cpu.times).reduce((x, y) => x + y, 0), idle: a.idle + cpu.times.idle }), { total: 0, idle: 0 });
}

export function parseProcStat(line: string): { row: ProcessRow; ticks: number } {
  const end = line.lastIndexOf(")");
  const fields = line.slice(end + 2).trim().split(/\s+/);
  return {
    row: { pid: Number(line.slice(0, line.indexOf(" "))), ppid: Number(fields[1]), name: line.slice(line.indexOf("(") + 1, end),
      state: fields[0], startTicks: fields[19], cpuPercent: null, rssBytes: Number(fields[21]) * 4096 },
    ticks: Number(fields[11]) + Number(fields[12]),
  };
}

export class ResourceSampler {
  private previous?: Counters;
  private processTicks = new Map<number, { start: string; ticks: number }>();
  private previousAt = 0;
  private gpu: Resources["gpu"] = null;
  private gpuAt: string | null = null;
  private gpuError: string | null = null;
  private disk: Resources["disk"] = null;
  private diskAt = 0;

  async sample(executions: Execution[]): Promise<Resources> {
    const now = Date.now(), current = counters();
    const delta = this.previous ? current.total - this.previous.total : 0;
    const cpuPercent = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - this.previous!.idle) / delta))) : null;
    this.previous = current;
    const names = process.platform === "linux" ? (await entries("/proc", PROCESS_LIMIT + 256)).filter(x => /^\d+$/.test(x)) : [];
    const processes: ProcessRow[] = [];
    const nextTicks = new Map<number, { start: string; ticks: number }>();
    const seconds = this.previousAt ? (now - this.previousAt) / 1000 : 0;
    const selected = names.slice(0, PROCESS_LIMIT);
    for (let i = 0; i < selected.length; i += 16) {
      await Promise.all(selected.slice(i, i + 16).map(async name => {
        try {
          const dir = `/proc/${name}`;
          if ((await stat(dir)).uid !== process.getuid?.()) return;
          const { row, ticks } = parseProcStat(await readFile(`${dir}/stat`, "utf8"));
          const old = this.processTicks.get(row.pid);
          // Linux USER_HZ=100; first observation intentionally has no rate.
          if (seconds > 0 && old?.start === row.startTicks) row.cpuPercent = Math.max(0, (ticks - old.ticks) / seconds);
          nextTicks.set(row.pid, { start: row.startTicks, ticks });
          processes.push(row);
        } catch { /* Concurrent exit. */ }
      }));
    }
    this.previousAt = now;
    this.processTicks = nextTicks;
    const byPid = new Map(processes.map(p => [p.pid, p]));
    for (const run of executions.filter(e => ["working", "input_required"].includes(e.status))) {
      for (const pid of [run.runnerPid, run.childPid]) if (pid && byPid.has(pid)) byPid.get(pid)!.runId = run.runId;
    }
    for (let i = 0; i < 12; i++) {
      let changed = false;
      for (const row of processes) if (!row.runId && byPid.get(row.ppid)?.runId) { row.runId = byPid.get(row.ppid)!.runId; changed = true; }
      if (!changed) break;
    }
    if (!this.gpuAt || now - Date.parse(this.gpuAt) >= 30_000) {
      this.gpuAt = new Date(now).toISOString();
      try {
        const { stdout } = await exec("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 1200, maxBuffer: 4096 });
        this.gpu = stdout.trim().split("\n").filter(Boolean).map(line => {
          const [name, utilization, usedMiB, totalMiB] = line.split(",").map(x => x.trim());
          return { name, utilization: Number(utilization), usedMiB: Number(usedMiB), totalMiB: Number(totalMiB) };
        });
        this.gpuError = null;
      } catch { this.gpu = null; this.gpuError = "GPU metrics unavailable"; }
    }
    if (!this.diskAt || now - this.diskAt >= 30_000) {
      this.diskAt = now;
      try {
        const fs = statfsSync(os.homedir());
        const totalBytes = Number(fs.blocks) * Number(fs.bsize);
        const availableBytes = Number(fs.bavail) * Number(fs.bsize);
        const pressure = classifyDiskPressure(availableBytes, totalBytes);
        this.disk = { availableBytes, totalBytes, usedBytes: totalBytes - availableBytes, pressure };
      } catch { this.disk = null; }
    }
    return { hostname: os.hostname(), sampledAt: new Date(now).toISOString(), cpuPercent, cores: os.cpus().length,
      totalMemory: os.totalmem(), usedMemory: os.totalmem() - os.freemem(), load: os.loadavg(),
      disk: this.disk,
      processes: processes.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)),
      processLimitReached: names.length >= PROCESS_LIMIT, gpu: this.gpu, gpuSampledAt: this.gpuAt, gpuError: this.gpuError };
  }
}
