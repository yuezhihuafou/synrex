import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ArchitectureModelManager } from "../src/architecture-model.js";
import { LearningStore } from "../src/learning-store.js";
import { SerenaSemanticManager } from "../src/serena-semantic.js";

const execFileAsync = promisify(execFile);

interface CapabilityResult {
  capability: "governance" | "semantic" | "learning";
  case: string;
  passed: boolean;
  metric: Record<string, number | string | boolean | null>;
}

const results: CapabilityResult[] = [];
results.push(...await benchmarkGovernance());
results.push(...await benchmarkSemantic());
results.push(...await benchmarkLearning());

for (const result of results) console.log(JSON.stringify(result));
const byCapability = Object.fromEntries(
  ["governance", "semantic", "learning"].map((capability) => {
    const rows = results.filter((row) => row.capability === capability);
    return [capability, {
      cases: rows.length,
      passed: rows.filter((row) => row.passed).length,
      passRate: rows.length === 0 ? null : rows.filter((row) => row.passed).length / rows.length,
    }];
  }),
);
console.log(JSON.stringify({ summary: byCapability }));
if (results.some((result) => !result.passed)) process.exitCode = 1;

async function benchmarkGovernance(): Promise<CapabilityResult[]> {
  const root = await mkdtemp(join(tmpdir(), "devspace-cap-governance-"));
  try {
    await mkdir(join(root, "src", "domain"), { recursive: true });
    await mkdir(join(root, "src", "adapters"), { recursive: true });
    await writeFile(join(root, "src", "domain", "order.ts"), "export const subtotal = 1;\n");
    await writeFile(join(root, "src", "adapters", "inventory.ts"), "export const stock = 1;\n");
    await writeFile(join(root, ".devspace-architecture.json"), `${JSON.stringify({
      version: 1,
      project: "capability-benchmark",
      policies: {
        acyclic: false,
        maxDepth: 12,
        dependencyRules: [{ kind: "forbid_dependency", from: "src/domain/**", to: "src/adapters/**" }],
      },
      annotations: [],
    }, null, 2)}\n`);
    const manager = new ArchitectureModelManager();
    await manager.initialize(root);
    const legalStart = performance.now();
    await writeFile(join(root, "src", "domain", "money.ts"), "export const roundMoney = (value: number) => Math.round(value * 100) / 100;\n");
    const legalIssues = await manager.conformance(root);
    const legalErrors = legalIssues.filter((item) => item.severity === "error").length;
    const legalMs = performance.now() - legalStart;

    const illegalStart = performance.now();
    await writeFile(join(root, "src", "domain", "order.ts"), 'import { stock } from "../adapters/inventory.js";\nexport const subtotal = stock;\n');
    const illegalIssues = await manager.conformance(root);
    const forbidden = illegalIssues.filter((item) => item.code === "forbidden-dependency").length;
    const illegalMs = performance.now() - illegalStart;
    return [
      {
        capability: "governance",
        case: "legal-change-not-blocked",
        passed: legalErrors === 0,
        metric: { errors: legalErrors, wallTimeMs: Math.round(legalMs * 100) / 100 },
      },
      {
        capability: "governance",
        case: "forbidden-dependency-blocked",
        passed: forbidden > 0,
        metric: { forbiddenDependencyErrors: forbidden, wallTimeMs: Math.round(illegalMs * 100) / 100 },
      },
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkSemantic(): Promise<CapabilityResult[]> {
  const root = await mkdtemp(join(tmpdir(), "devspace-cap-semantic-"));
  try {
    await writeFile(join(root, "symbols.ts"), [
      "export function target(value: number) { return value + 1; }",
      "export function caller() { return target(2); }",
      "export const text = 'target(pretend)';",
      "// target(fake-comment)",
      "",
    ].join("\n"));

    const grepStart = performance.now();
    const grep = await execFileAsync("grep", ["-n", "target", "symbols.ts"], { cwd: root });
    const grepLines = grep.stdout.trim().split(/\r?\n/).filter(Boolean).length;
    const grepMs = performance.now() - grepStart;

    const semantic = new SerenaSemanticManager();
    if (!semantic.available) {
      return [{
        capability: "semantic",
        case: "semantic-reference-precision",
        passed: false,
        metric: { available: false, grepHits: grepLines, grepWallTimeMs: Math.round(grepMs * 100) / 100 },
      }];
    }
    try {
      const findStart = performance.now();
      const found = await semantic.call(root, "find_symbol", {
        name_path_pattern: "target",
        relative_path: "symbols.ts",
        include_body: false,
        max_answer_chars: 4_000,
      });
      const findMs = performance.now() - findStart;
      const refsStart = performance.now();
      const refs = await semantic.call(root, "find_referencing_symbols", {
        name_path: "target",
        relative_path: "symbols.ts",
        max_answer_chars: 4_000,
      });
      const refsMs = performance.now() - refsStart;
      const foundTarget = /target/.test(found.result);
      const referenceEntries = countSemanticReferenceEntries(refs.result);
      const foundCaller = referenceEntries === 1 && /caller/.test(refs.result);
      return [{
        capability: "semantic",
        case: "semantic-reference-precision",
        passed: grepLines >= 4 && foundTarget && foundCaller,
        metric: {
          available: true,
          grepHits: grepLines,
          grepIncludesKnownFalsePositives: grepLines >= 4,
          semanticFoundDefinition: foundTarget,
          semanticFoundRealCaller: foundCaller,
          semanticReferenceEntries: referenceEntries,
          grepWallTimeMs: Math.round(grepMs * 100) / 100,
          semanticFindWallTimeMs: Math.round(findMs * 100) / 100,
          semanticReferencesWallTimeMs: Math.round(refsMs * 100) / 100,
        },
      }];
    } finally {
      await semantic.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function countSemanticReferenceEntries(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown[]>>;
    return Object.values(parsed).reduce((total, groups) => (
      total + Object.values(groups).reduce((subtotal, entries) => subtotal + (Array.isArray(entries) ? entries.length : 0), 0)
    ), 0);
  } catch {
    return 0;
  }
}

async function benchmarkLearning(): Promise<CapabilityResult[]> {
  const root = await mkdtemp(join(tmpdir(), "devspace-cap-learning-"));
  try {
    const workspaceRoot = join(root, "project");
    const store = new LearningStore(join(root, "state"));
    store.recordToolCall({
      workspaceRoot,
      tool: "exec_command",
      toolInput: { cmd: "pnpm test --filter architecture" },
      toolOutput: { structuredContent: { result: "architecture regression suite passed" } },
    });
    for (let index = 0; index < 12; index += 1) {
      store.recordToolCall({
        workspaceRoot,
        tool: "exec_command",
        toolInput: { cmd: `printf distractor-${index}` },
        toolOutput: { structuredContent: { result: `unrelated output ${index}` } },
      });
    }
    store.recordToolCall({
      workspaceRoot,
      tool: "exec_command",
      toolInput: { cmd: "architecture regression failing probe" },
      toolOutput: {
        isError: true,
        structuredContent: { result: "architecture regression failed" },
      },
    });
    const recencyBaseline = store.recentSuccessfulEpisodes(workspaceRoot, 8);
    const baselineHit = recencyBaseline.some((episode) => /architecture/.test(`${episode.inputSummary} ${episode.outputSummary}`));
    const recalled = store.recall(workspaceRoot, "architecture regression", 8);
    const recallHit = recalled.episodes.some((episode) => /architecture/.test(`${episode.inputSummary} ${episode.outputSummary}`));
    const failedEvidence = recalled.episodes.find((episode) => !episode.success);
    let rejectedFailedEvidence = false;
    if (failedEvidence) {
      try {
        store.distill({
          workspaceRoot,
          title: "Invalid Architecture Evidence",
          trigger: "Never promote failed evidence.",
          procedure: ["Do not learn from a failed verification."],
          evidenceEpisodeIds: [failedEvidence.id],
        });
      } catch {
        rejectedFailedEvidence = true;
      }
    }
    const candidate = store.distill({
      workspaceRoot,
      title: "Architecture Regression Verification",
      trigger: "Use after changing architecture-sensitive code.",
      procedure: ["Run pnpm test --filter architecture.", "Inspect architecture conformance before review."],
      evidenceEpisodeIds: recalled.episodes
        .filter((episode) => episode.success && /architecture/.test(`${episode.inputSummary} ${episode.outputSummary}`))
        .map((episode) => episode.id),
    });
    let rejectedUnvalidatedPromotion = false;
    try {
      await store.promote(workspaceRoot, candidate.id, "");
    } catch {
      rejectedUnvalidatedPromotion = true;
    }
    const promoted = await store.promote(workspaceRoot, candidate.id, "Capability benchmark verified retrieval and current procedure.");
    return [
      {
        capability: "learning",
        case: "query-recall-beats-recency",
        passed: !baselineHit && recallHit,
        metric: { baselineTop8Hit: baselineHit, queryRecallTop8Hit: recallHit },
      },
      {
        capability: "learning",
        case: "promotion-requires-explicit-note",
        passed: rejectedUnvalidatedPromotion
          && rejectedFailedEvidence
          && promoted.status === "promoted"
          && Boolean(promoted.skillPath),
        metric: {
          rejectedMissingNote: rejectedUnvalidatedPromotion,
          promotedWithExplicitNote: promoted.status === "promoted",
          evidenceBindingVerified: rejectedFailedEvidence,
        },
      },
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
