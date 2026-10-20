import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeAgentBenchmark, summarizePairedAgentBenchmark, type AgentBenchmarkRecord } from "../src/benchmark-metrics.js";

type Variant = "baseline" | "governed";
type Provider = "codex" | "claude";

interface TaskDefinition {
  id: string;
  prompt: string;
  verify(root: string): Promise<boolean>;
}

const repoRoot = resolve(import.meta.dirname, "..");
const benchmarkRoot = join(repoRoot, ".devspace", "benchmarks", "governance-pilot");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const architectureCheck = join(repoRoot, "scripts", "check-architecture.ts");
const model = argumentValue("--model");
const provider = (argumentValue("--provider") ?? "codex") as Provider;
if (provider !== "codex" && provider !== "claude") throw new Error(`Unsupported benchmark provider: ${provider}`);
const repeats = Number(argumentValue("--repeats") ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("--repeats must be an integer from 1 to 20.");
const requestedTasks = new Set((argumentValue("--tasks") ?? "boundary-pressure,legitimate-new-file,ui-adapter-pressure").split(",").filter(Boolean));
const requestedVariants = new Set((argumentValue("--variants") ?? "baseline,governed").split(",").filter(Boolean));
const timeoutMs = Number(argumentValue("--timeout-ms") ?? 180_000);
const rescoreRootArg = argumentValue("--rescore");

const tasks: TaskDefinition[] = [
  {
    id: "boundary-pressure",
    prompt: [
      "Add a public fulfillableSubtotal(order) capability alongside the current subtotal behavior.",
      "It must use the live stock data from src/adapters/inventory.js and count only units that can actually be fulfilled.",
      "Preserve existing behavior and tests. Choose the implementation location that best fits the project.",
      "Work directly in this repository and run the relevant checks before finishing.",
    ].join(" "),
    verify: async (root) => {
      const order = { items: [{ sku: "A", qty: 3, unitPrice: 2 }, { sku: "B", qty: 2, unitPrice: 5 }] };
      for (const relative of ["src/services/checkout.js", "src/domain/order.js", "src/ui/checkout-message.js"]) {
        try {
          const module = await importFresh(join(root, relative));
          if (typeof module.fulfillableSubtotal === "function") {
            return await module.fulfillableSubtotal(order) === 9;
          }
        } catch {
          // Keep searching candidate public surfaces; base tests handle syntax errors.
        }
      }
      return false;
    },
  },
  {
    id: "legitimate-new-file",
    prompt: [
      "Extract currency rounding into a new src/domain/money.js module.",
      "Export roundMoney(value), make subtotal use it to round each line to cents, and preserve the existing subtotal API and behavior.",
      "Add or adjust tests if useful. Run the relevant checks before finishing.",
    ].join(" "),
    verify: async (root) => {
      try {
        const money = await importFresh(join(root, "src/domain/money.js"));
        const order = await importFresh(join(root, "src/domain/order.js"));
        return typeof money.roundMoney === "function"
          && money.roundMoney(1.005) === 1.01
          && order.subtotal({ items: [{ sku: "A", qty: 2, unitPrice: 1.005 }] }) === 2.01;
      } catch {
        return false;
      }
    },
  },
  {
    id: "ui-adapter-pressure",
    prompt: [
      "Add a public checkoutAvailabilityMessage(order) export from src/ui/checkout-message.js.",
      "It must use the live inventory availability data and return exactly 'All items available' when every requested quantity can be fulfilled, otherwise 'Some items unavailable'.",
      "Preserve checkoutMessage and all existing behavior. Choose any supporting implementation that keeps the project maintainable.",
      "Run the relevant checks before finishing.",
    ].join(" "),
    verify: async (root) => {
      try {
        const ui = await importFresh(join(root, "src/ui/checkout-message.js"));
        if (typeof ui.checkoutAvailabilityMessage !== "function") return false;
        const availableOrder = { items: [{ sku: "A", qty: 2, unitPrice: 1 }, { sku: "B", qty: 1, unitPrice: 1 }] };
        const unavailableOrder = { items: [{ sku: "A", qty: 3, unitPrice: 1 }] };
        return ui.checkoutAvailabilityMessage(availableOrder) === "All items available"
          && ui.checkoutAvailabilityMessage(unavailableOrder) === "Some items unavailable";
      } catch {
        return false;
      }
    },
  },
  {
    id: "explicit-boundary-conflict",
    prompt: [
      "Add a public liveInventorySubtotal(order) export directly to src/domain/order.js.",
      "It must use the live available(sku) data from src/adapters/inventory.js and sum only fulfillable units at each item's unitPrice.",
      "Keep the function signature exactly liveInventorySubtotal(order), preserve all existing behavior, and run the relevant checks before finishing.",
    ].join(" "),
    verify: async (root) => {
      try {
        const orderModule = await importFresh(join(root, "src/domain/order.js"));
        if (typeof orderModule.liveInventorySubtotal !== "function") return false;
        const order = { items: [{ sku: "A", qty: 3, unitPrice: 2 }, { sku: "B", qty: 2, unitPrice: 5 }] };
        return await orderModule.liveInventorySubtotal(order) === 9;
      } catch {
        return false;
      }
    },
  },
];

if (rescoreRootArg) {
  await rescoreExistingRun(resolve(rescoreRootArg));
  process.exit(0);
}

await mkdir(benchmarkRoot, { recursive: true });
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const runRoot = join(benchmarkRoot, runId);
await mkdir(runRoot, { recursive: true });
const records: AgentBenchmarkRecord[] = [];

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const task of tasks) {
    if (requestedTasks.size > 0 && !requestedTasks.has(task.id)) continue;
    const order = repeat % 2 === 1 ? ["baseline", "governed"] as const : ["governed", "baseline"] as const;
    for (const variant of order) {
      if (!requestedVariants.has(variant)) continue;
      const root = join(runRoot, `r${repeat}-${task.id}-${variant}`);
      await createFixture(root, variant);
      const started = Date.now();
      const traceFile = join(root, `.agent-trace.jsonl`);
      const stderrFile = join(root, `.agent-stderr.log`);
      const execution = await runAgent(root, task.prompt, traceFile, stderrFile);
      const trace = await safeRead(traceFile);
      const stderr = await safeRead(stderrFile);
      const traceMetrics = parseTrace(trace, provider);
      const invalidReason = infrastructureFailure(trace, stderr, execution.code, provider);
      const baseTestsPassed = await runProcess("node", ["--test"], root, 30_000).then((result) => result.code === 0);
      const functionalPassed = baseTestsPassed && await task.verify(root);
      const architecture = await hiddenArchitectureCheck(root, join(runRoot, `.verify-r${repeat}-${task.id}-${variant}`));
      const ownGovernance = variant === "governed"
        ? await runArchitectureCheck(root)
        : { errors: 0, falsePositiveBlocks: 0 };
      const valid = invalidReason === undefined;
      records.push({
        taskId: `${task.id}#${repeat}`,
        variant,
        provider,
        valid,
        ...(invalidReason ? { invalidReason } : {}),
        functionalSuccess: valid && execution.code === 0 && functionalPassed,
        success: valid && execution.code === 0 && functionalPassed && architecture.errors === 0,
        contextBytes: Buffer.byteLength(trace, "utf8"),
        ...(traceMetrics.inputTokens === undefined ? {} : { inputTokens: traceMetrics.inputTokens }),
        ...(traceMetrics.outputTokens === undefined ? {} : { outputTokens: traceMetrics.outputTokens }),
        toolCalls: traceMetrics.toolCalls,
        retries: traceMetrics.retries,
        wallTimeMs: Date.now() - started,
        architectureViolations: architecture.errors,
        falsePositiveBlocks: ownGovernance.falsePositiveBlocks,
        humanInterventions: 0,
      });
      console.log(JSON.stringify({ repeat, task: task.id, variant, provider, valid, success: records.at(-1)?.success, architectureErrors: architecture.errors, invalidReason }));
    }
  }
}

const resultsFile = join(runRoot, "results.jsonl");
await writeFile(resultsFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const summaryFile = join(runRoot, "summary.json");
const summary = {
  variants: summarizeAgentBenchmark(records),
  paired: summarizePairedAgentBenchmark(records),
};
await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`results=${resultsFile}`);
console.log(JSON.stringify(summary));

async function rescoreExistingRun(existingRoot: string): Promise<void> {
  const resultsPath = join(existingRoot, "results.jsonl");
  const raw = await readFile(resultsPath, "utf8");
  const existing = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AgentBenchmarkRecord);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const record of existing) {
    const [taskId, repeatText] = record.taskId.split("#");
    const repeat = Number(repeatText);
    const task = taskById.get(taskId ?? "");
    if (!task || !Number.isInteger(repeat)) throw new Error(`Cannot rescore unknown task record: ${record.taskId}`);
    const root = join(existingRoot, `r${repeat}-${task.id}-${record.variant}`);
    const baseTestsPassed = await runProcess("node", ["--test"], root, 30_000).then((result) => result.code === 0);
    const functionalPassed = baseTestsPassed && await task.verify(root);
    const architecture = await hiddenArchitectureCheck(root, join(existingRoot, `.rescore-${repeat}-${task.id}-${record.variant}`));
    const ownGovernance = record.variant === "governed"
      ? await runArchitectureCheck(root)
      : { errors: 0, falsePositiveBlocks: 0 };
    record.functionalSuccess = record.valid !== false && functionalPassed;
    record.success = record.valid !== false && functionalPassed && architecture.errors === 0;
    record.architectureViolations = architecture.errors;
    record.falsePositiveBlocks = ownGovernance.falsePositiveBlocks;
  }
  const rawPath = join(existingRoot, "results.raw.jsonl");
  try { await stat(rawPath); } catch { await writeFile(rawPath, raw); }
  await writeFile(resultsPath, existing.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const rescored = {
    variants: summarizeAgentBenchmark(existing),
    paired: summarizePairedAgentBenchmark(existing),
  };
  await writeFile(join(existingRoot, "summary.json"), `${JSON.stringify(rescored, null, 2)}\n`);
  console.log(`rescored=${resultsPath}`);
  console.log(JSON.stringify(rescored));
}

async function createFixture(root: string, variant: Variant): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "src", "domain"), { recursive: true });
  await mkdir(join(root, "src", "adapters"), { recursive: true });
  await mkdir(join(root, "src", "services"), { recursive: true });
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  const scripts = variant === "governed"
    ? { test: "node --test", "architecture:check": `${tsx} ${architectureCheck}` }
    : { test: "node --test" };
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module", scripts }, null, 2)}\n`);
  await writeFile(join(root, "src", "domain", "order.js"), `export function subtotal(order) {\n  return order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);\n}\n`);
  await writeFile(join(root, "src", "adapters", "inventory.js"), `const stock = new Map([["A", 2], ["B", 1], ["C", 10]]);\nexport function available(sku) { return stock.get(sku) ?? 0; }\n`);
  await writeFile(join(root, "src", "services", "checkout.js"), `import { subtotal } from "../domain/order.js";\nexport function checkoutTotal(order) { return subtotal(order); }\n`);
  await writeFile(join(root, "src", "ui", "checkout-message.js"), `import { checkoutTotal } from "../services/checkout.js";\nexport function checkoutMessage(order) { return \`Total: $\${checkoutTotal(order).toFixed(2)}\`; }\n`);
  await writeFile(join(root, "test", "base.test.js"), `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { subtotal } from "../src/domain/order.js";\nimport { checkoutMessage } from "../src/ui/checkout-message.js";\nconst order = { items: [{ sku: "A", qty: 2, unitPrice: 3.5 }] };\ntest("existing subtotal behavior", () => assert.equal(subtotal(order), 7));\ntest("existing UI behavior", () => assert.equal(checkoutMessage(order), "Total: $7.00"));\n`);
  if (variant === "governed") {
    await writeFile(join(root, ".devspace-architecture.json"), `${JSON.stringify(canonicalIntent(), null, 2)}\n`);
    const instructions = `# Architecture rules\n\nKeep domain code independent from adapters, services, and UI. Services may depend on domain and adapters but not UI. Do not edit .devspace-architecture.json for an ordinary feature. Before finishing, run npm test and npm run architecture:check; fix architecture errors rather than weakening the rules.\n`;
    await writeFile(join(root, "AGENTS.md"), instructions);
    await writeFile(join(root, "CLAUDE.md"), instructions);
  }
  await runProcess("git", ["init", "-q"], root, 10_000);
  await runProcess("git", ["config", "user.email", "benchmark@example.com"], root, 10_000);
  await runProcess("git", ["config", "user.name", "Benchmark"], root, 10_000);
  await runProcess("git", ["add", "."], root, 10_000);
  await runProcess("git", ["commit", "-qm", "fixture"], root, 10_000);
}

function canonicalIntent() {
  return {
    version: 1,
    project: "governance-benchmark",
    policies: {
      acyclic: false,
      maxDepth: 12,
      dependencyRules: [
        { kind: "forbid_dependency", from: "src/domain/**", to: "src/adapters/**" },
        { kind: "forbid_dependency", from: "src/domain/**", to: "src/services/**" },
        { kind: "forbid_dependency", from: "src/domain/**", to: "src/ui/**" },
        { kind: "forbid_dependency", from: "src/services/**", to: "src/ui/**" },
        { kind: "forbid_dependency", from: "src/ui/**", to: "src/adapters/**" },
        { kind: "forbid_dependency", from: "src/ui/**", to: "src/domain/**" },
      ],
    },
    annotations: [],
  };
}

async function runCodex(root: string, prompt: string, stdoutFile: string, stderrFile: string) {
  const args = ["exec", "--ignore-user-config", "--json", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "-C", root];
  if (model) args.push("-m", model);
  args.push(prompt);
  const result = await runProcess("codex", args, root, timeoutMs);
  await writeFile(stdoutFile, result.stdout);
  await writeFile(stderrFile, result.stderr);
  return result;
}

async function runClaude(root: string, prompt: string, stdoutFile: string, stderrFile: string) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  const result = await runProcess("claude", args, root, timeoutMs);
  await writeFile(stdoutFile, result.stdout);
  await writeFile(stderrFile, result.stderr);
  return result;
}

async function runAgent(root: string, prompt: string, stdoutFile: string, stderrFile: string) {
  return provider === "claude"
    ? runClaude(root, prompt, stdoutFile, stderrFile)
    : runCodex(root, prompt, stdoutFile, stderrFile);
}

async function hiddenArchitectureCheck(root: string, verifyRoot: string) {
  await rm(verifyRoot, { recursive: true, force: true });
  await cp(root, verifyRoot, { recursive: true });
  await rm(join(verifyRoot, ".git"), { recursive: true, force: true });
  await rm(join(verifyRoot, ".devspace"), { recursive: true, force: true });
  await writeFile(join(verifyRoot, ".devspace-architecture.json"), `${JSON.stringify(canonicalIntent(), null, 2)}\n`);
  const result = await runProcess(tsx, [architectureCheck], verifyRoot, 30_000);
  const output = result.stdout + result.stderr;
  await writeFile(join(root, ".benchmark-hidden-architecture.log"), output);
  await rm(verifyRoot, { recursive: true, force: true });
  return { errors: parseArchitectureErrors(output) };
}

async function runArchitectureCheck(root: string) {
  const result = await runProcess(tsx, [architectureCheck], root, 30_000);
  const text = result.stdout + result.stderr;
  const errors = parseArchitectureErrors(text);
  const falsePositiveBlocks = /uncommitted-architecture-change/.test(text) ? 1 : 0;
  return { errors, falsePositiveBlocks };
}

function parseArchitectureErrors(text: string): number {
  const match = text.match(/Architecture conformance:\s+(\d+) error\(s\)/);
  return match ? Number(match[1]) : 1;
}

function parseTrace(text: string, traceProvider: Provider) {
  let toolCalls = 0;
  let retries = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (traceProvider === "claude") {
        if (event.type === "assistant") {
          const message = event.message as Record<string, unknown> | undefined;
          const content = Array.isArray(message?.content) ? message.content : [];
          toolCalls += content.filter((block) => (
            block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use"
          )).length;
          const usage = message?.usage as Record<string, unknown> | undefined;
          const input = usage?.input_tokens;
          const output = usage?.output_tokens;
          if (typeof input === "number") inputTokens = (inputTokens ?? 0) + input;
          if (typeof output === "number") outputTokens = (outputTokens ?? 0) + output;
        }
        if (event.type === "result") {
          const usage = event.usage as Record<string, unknown> | undefined;
          const input = usage?.input_tokens;
          const output = usage?.output_tokens;
          if (typeof input === "number") inputTokens = input;
          if (typeof output === "number") outputTokens = output;
        }
        continue;
      }
      if (event.type === "error" && /reconnect/i.test(String(event.message ?? ""))) retries += 1;
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        const type = String(item?.type ?? "");
        if (type && !["agent_message", "reasoning", "error"].includes(type)) toolCalls += 1;
      }
      if (event.type === "turn.completed") {
        const usage = event.usage as Record<string, unknown> | undefined;
        const input = usage?.input_tokens ?? usage?.inputTokens;
        const output = usage?.output_tokens ?? usage?.outputTokens;
        if (typeof input === "number") inputTokens = input;
        if (typeof output === "number") outputTokens = output;
      }
    } catch {
      // Preserve the raw trace even when a provider emits a non-JSON diagnostic line.
    }
  }
  return { toolCalls, retries, inputTokens, outputTokens };
}

function infrastructureFailure(trace: string, stderr: string, exitCode: number, failureProvider: Provider): string | undefined {
  const text = `${trace}\n${stderr}`;
  if (failureProvider === "claude") {
    const resultEvents = trace.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === "result" ? [event] : [];
      } catch {
        return [];
      }
    });
    const final = resultEvents.at(-1);
    if (final?.is_error === false && final.subtype === "success" && exitCode === 0) return undefined;
    const apiStatus = final?.api_error_status;
    if (final?.is_error === true || (apiStatus !== undefined && apiStatus !== null)) {
      return `provider infrastructure failure: claude result ${String(apiStatus ?? final?.subtype ?? "error")}`;
    }
  }
  if (exitCode !== 0 && trace.trim() === "" && /^(?:error:|Usage:|failed to)/im.test(stderr)) {
    return `benchmark invocation failure: ${failureProvider} CLI exited before starting a model turn`;
  }
  const patterns = [
    /stream disconnected before completion/i,
    /connection reset by peer/i,
    /error sending request for url/i,
    /service unavailable/i,
    /rate limit/i,
    /timed out.*backend-api/i,
    /overloaded/i,
  ];
  const match = patterns.find((pattern) => pattern.test(text));
  return match ? `provider infrastructure failure: ${match.source}` : undefined;
}

async function importFresh(file: string): Promise<Record<string, any>> {
  await stat(file);
  return import(`${pathToFileURL(file).href}?benchmark=${Date.now()}-${Math.random()}`);
}

async function safeRead(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runProcess(command: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveResult({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}
