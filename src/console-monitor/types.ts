import type { ConsoleSnapshot } from "../console-snapshot.js";
import type { PeerReadings } from "./peers.js";
import type { TunnelRecoverySummary } from "./tunnel-recovery.js";

export interface Execution {
  runId: string;
  taskId?: string;
  workspaceId?: string;
  project: string;
  cwd: string;
  command: string;
  commandTruncated?: boolean;
  status: string;
  startedAt: string;
  finishedAt?: string;
  lastActivityAt?: string;
  durationMs: number;
  outputBytes: number;
  exitCode: number | null;
  runnerPid?: number;
  childPid?: number;
  canCancel: boolean;
  observation: string;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  startTicks: string;
  cpuPercent: number | null;
  rssBytes: number;
  runId?: string;
}

export interface Resources {
  hostname: string;
  sampledAt: string;
  cpuPercent: number | null;
  cores: number;
  totalMemory: number;
  usedMemory: number;
  /** Observed local filesystem only; no inferred peer disk status. */
  disk?: { availableBytes: number; totalBytes: number; usedBytes: number;
    pressure: "ok" | "warning" | "critical" } | null;
  load: number[];
  processes: ProcessRow[];
  processLimitReached: boolean;
  gpu: Array<{ name: string; utilization: number; usedMiB: number; totalMiB: number }> | null;
  gpuSampledAt: string | null;
  gpuError: string | null;
}

export interface StatsFilter { minutes: number; tool?: string; workspace?: string }
export interface MetricSummary {
  count: number;
  ok: number;
  errors: number;
  incomplete: number;
  latencyCount: number;
  p50: number | null;
  p95: number | null;
}
export interface Statistics {
  since: string;
  until: string;
  observationStartedAt: string;
  coverage: string;
  requests: MetricSummary;
  tools: Array<MetricSummary & { name: string }>;
  stages: Array<MetricSummary & { name: string }>;
  nodes: Array<MetricSummary & { name: string }>;
  series: Array<{ at: string; count: number; errors: number }>;
  tasks: { count: number; completed: number; failed: number; cancelled: number; active: number; p50: number | null; p95: number | null };
  options: { tools: string[]; workspaces: string[] };
  detailSamples: number;
}

export interface MonitorSnapshot {
  generatedAt: string;
  sampledAt: string;
  sampleMs: number;
  source: { node: string; release: string; scope: string; management: string };
  resources: Resources | null;
  tunnelRecovery?: TunnelRecoverySummary;
  remote: PeerReadings;
  executions: Execution[];
  base: ConsoleSnapshot | null;
  warnings: string[];
  limits: { runs: number; processes: number; logBytes: number; events: number; retentionDays: number };
}
