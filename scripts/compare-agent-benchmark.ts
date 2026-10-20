import { readFile } from "node:fs/promises";
import { summarizeAgentBenchmark, summarizePairedAgentBenchmark, type AgentBenchmarkRecord } from "../src/benchmark-metrics.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: pnpm benchmark:compare <results.jsonl>");
const records = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AgentBenchmarkRecord);

for (const row of summarizeAgentBenchmark(records)) {
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ paired: summarizePairedAgentBenchmark(records) }));
