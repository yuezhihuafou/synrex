export interface AgentBenchmarkRecord {
  taskId: string;
  variant: string;
  provider?: string;
  model?: string;
  effort?: string;
  startingCommit?: string;
  environmentId?: string;
  valid?: boolean;
  invalidReason?: string;
  success: boolean;
  functionalSuccess?: boolean;
  /** Omit when the host does not expose comparable context or wire bytes. Never substitute zero. */
  contextBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  retries: number;
  wallTimeMs: number;
  architectureViolations: number;
  falsePositiveBlocks: number;
  humanInterventions: number;
  /** Only defined for a run that exercised actual recovery. */
  recoverySuccess?: boolean;
}

export interface AgentBenchmarkSummary {
  variant: string;
  attemptedRuns: number;
  invalidRuns: number;
  tasks: number;
  successRate: number | null;
  functionalSuccessRate: number | null;
  meanContextBytes: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanToolCalls: number | null;
  medianToolCalls: number | null;
  meanRetries: number | null;
  meanWallTimeMs: number | null;
  medianWallTimeMs: number | null;
  meanArchitectureViolations: number | null;
  meanFalsePositiveBlocks: number | null;
  meanHumanInterventions: number | null;
  medianHumanInterventions: number | null;
  recoveryRuns: number;
  recoverySuccessRate: number | null;
}

export interface PairedAgentBenchmarkSummary {
  pairs: number;
  incomparablePairs: number;
  bothSucceeded: number;
  governedOnlySucceeded: number;
  baselineOnlySucceeded: number;
  bothFailed: number;
  meanArchitectureViolationDelta: number | null;
  meanInputTokenDelta: number | null;
  meanOutputTokenDelta: number | null;
  meanToolCallDelta: number | null;
  meanWallTimeDeltaMs: number | null;
  medianWallTimeDeltaMs: number | null;
}

export function summarizeAgentBenchmark(records: AgentBenchmarkRecord[]): AgentBenchmarkSummary[] {
  const grouped = new Map<string, AgentBenchmarkRecord[]>();
  for (const record of records) {
    validateRecord(record);
    const list = grouped.get(record.variant) ?? [];
    list.push(record);
    grouped.set(record.variant, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variant, rows]) => {
      const valid = rows.filter((row) => row.valid !== false);
      return {
        variant,
        attemptedRuns: rows.length,
        invalidRuns: rows.length - valid.length,
        tasks: valid.length,
        successRate: meanOrNull(valid.map((row) => row.success ? 1 : 0)),
        functionalSuccessRate: meanOrNull(valid.map((row) => (row.functionalSuccess ?? row.success) ? 1 : 0)),
        meanContextBytes: meanOrNull(valid.flatMap((row) => row.contextBytes === undefined ? [] : [row.contextBytes])),
        meanInputTokens: meanOrNull(valid.flatMap((row) => row.inputTokens === undefined ? [] : [row.inputTokens])),
        meanOutputTokens: meanOrNull(valid.flatMap((row) => row.outputTokens === undefined ? [] : [row.outputTokens])),
        meanToolCalls: meanOrNull(valid.map((row) => row.toolCalls)),
        medianToolCalls: medianOrNull(valid.map((row) => row.toolCalls)),
        meanRetries: meanOrNull(valid.map((row) => row.retries)),
        meanWallTimeMs: meanOrNull(valid.map((row) => row.wallTimeMs)),
        medianWallTimeMs: medianOrNull(valid.map((row) => row.wallTimeMs)),
        meanArchitectureViolations: meanOrNull(valid.map((row) => row.architectureViolations)),
        meanFalsePositiveBlocks: meanOrNull(valid.map((row) => row.falsePositiveBlocks)),
        meanHumanInterventions: meanOrNull(valid.map((row) => row.humanInterventions)),
        medianHumanInterventions: medianOrNull(valid.map((row) => row.humanInterventions)),
        recoveryRuns: valid.filter((row) => row.recoverySuccess !== undefined).length,
        recoverySuccessRate: meanOrNull(valid.flatMap((row) => row.recoverySuccess === undefined ? [] : [row.recoverySuccess ? 1 : 0])),
      };
    });
}

export function summarizePairedAgentBenchmark(records: AgentBenchmarkRecord[]): PairedAgentBenchmarkSummary {
  const byTask = new Map<string, Partial<Record<"baseline" | "governed", AgentBenchmarkRecord>>>();
  for (const record of records) {
    if (record.valid === false || (record.variant !== "baseline" && record.variant !== "governed")) continue;
    const pair = byTask.get(record.taskId) ?? {};
    if (pair[record.variant]) {
      throw new Error(`Duplicate benchmark run for task ${record.taskId}, variant ${record.variant}; use unique repeat taskIds.`);
    }
    pair[record.variant] = record;
    byTask.set(record.taskId, pair);
  }
  const candidates = [...byTask.values()].flatMap((pair) => (
    pair.baseline && pair.governed ? [{ baseline: pair.baseline, governed: pair.governed }] : []
  ));
  // Missing controls do not establish equality: two unknown models or
  // starting commits cannot support a controlled GPT performance claim.
  const pairs = candidates.filter(({ baseline, governed }) =>
    (["provider", "model", "effort", "startingCommit", "environmentId"] as const)
      .every((key) => typeof baseline[key] === "string"
        && baseline[key]!.trim().length > 0
        && baseline[key] === governed[key]));
  return {
    pairs: pairs.length,
    incomparablePairs: candidates.length - pairs.length,
    bothSucceeded: pairs.filter(({ baseline, governed }) => baseline.success && governed.success).length,
    governedOnlySucceeded: pairs.filter(({ baseline, governed }) => !baseline.success && governed.success).length,
    baselineOnlySucceeded: pairs.filter(({ baseline, governed }) => baseline.success && !governed.success).length,
    bothFailed: pairs.filter(({ baseline, governed }) => !baseline.success && !governed.success).length,
    meanArchitectureViolationDelta: meanOrNull(pairs.map(({ baseline, governed }) => governed.architectureViolations - baseline.architectureViolations)),
    meanInputTokenDelta: meanOrNull(pairs.flatMap(({ baseline, governed }) => (
      baseline.inputTokens === undefined || governed.inputTokens === undefined ? [] : [governed.inputTokens - baseline.inputTokens]
    ))),
    meanOutputTokenDelta: meanOrNull(pairs.flatMap(({ baseline, governed }) => (
      baseline.outputTokens === undefined || governed.outputTokens === undefined ? [] : [governed.outputTokens - baseline.outputTokens]
    ))),
    meanToolCallDelta: meanOrNull(pairs.map(({ baseline, governed }) => governed.toolCalls - baseline.toolCalls)),
    meanWallTimeDeltaMs: meanOrNull(pairs.map(({ baseline, governed }) => governed.wallTimeMs - baseline.wallTimeMs)),
    medianWallTimeDeltaMs: medianOrNull(pairs.map(({ baseline, governed }) => governed.wallTimeMs - baseline.wallTimeMs)),
  };
}

function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function validateRecord(record: AgentBenchmarkRecord): void {
  if (!record.taskId || !record.variant) throw new Error("Benchmark records require taskId and variant.");
  for (const key of [
    "toolCalls", "retries", "wallTimeMs", "architectureViolations",
    "falsePositiveBlocks", "humanInterventions",
  ] as const) {
    const value = record[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`Benchmark ${key} must be a non-negative finite number.`);
  }
  if (record.contextBytes !== undefined && (!Number.isFinite(record.contextBytes) || record.contextBytes < 0)) {
    throw new Error("Benchmark contextBytes must be a non-negative finite number when supplied.");
  }
}
