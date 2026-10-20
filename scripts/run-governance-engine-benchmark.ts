import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ArchitectureModelManager } from "../src/architecture-model.js";

interface CaseResult {
  id: string;
  expectedBlock: boolean;
  observedBlock: boolean;
  errorCodes: string[];
  wallTimeMs: number;
}

const cases: Array<{ id: string; expectedBlock: boolean; run(root: string, manager: ArchitectureModelManager): Promise<void> }> = [
  {
    id: "legitimate-new-file",
    expectedBlock: false,
    run: async (root) => {
      await writeFile(join(root, "src", "domain", "money.js"), "export const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;\n");
    },
  },
  {
    id: "forbidden-ts-import",
    expectedBlock: true,
    run: async (root) => {
      await writeFile(join(root, "src", "domain", "order.ts"), 'import { stock } from "../adapters/inventory.js";\nexport const order = stock;\n');
      await writeFile(join(root, "src", "adapters", "inventory.ts"), "export const stock = 1;\n");
    },
  },
  {
    id: "forbidden-python-import",
    expectedBlock: true,
    run: async (root) => {
      await writeFile(join(root, "src", "domain", "order.py"), "from ..adapters.inventory import stock\nvalue = stock\n");
      await writeFile(join(root, "src", "adapters", "inventory.py"), "stock = 1\n");
    },
  },
  {
    id: "forbidden-cpp-include",
    expectedBlock: true,
    run: async (root) => {
      await writeFile(join(root, "src", "domain", "order.cpp"), '#include "../adapters/inventory.hpp"\nint value() { return stock(); }\n');
      await writeFile(join(root, "src", "adapters", "inventory.hpp"), "inline int stock() { return 1; }\n");
    },
  },
  {
    id: "unauthorized-intent-change",
    expectedBlock: true,
    run: async (root) => {
      const changed = architectureIntent();
      changed.policies.maxDepth = 20;
      await writeFile(join(root, ".devspace-architecture.json"), `${JSON.stringify(changed, null, 2)}\n`);
    },
  },
  {
    id: "authorized-intent-change",
    expectedBlock: false,
    run: async (root, manager) => {
      const change = await manager.openChange(root, "Allow a deeper source layout", [], {
        architectureChange: true,
        rationale: "Controlled benchmark of the approved architecture-change path.",
      });
      await manager.updatePolicy(root, change.id, { maxDepth: 20 });
      await manager.closeChange(root, change.id);
    },
  },
];

const results: CaseResult[] = [];
for (const item of cases) {
  const root = await createFixture();
  const manager = new ArchitectureModelManager();
  await manager.initialize(root);
  const started = performance.now();
  await item.run(root, manager);
  const issues = await manager.conformance(root);
  const errors = issues.filter((issue) => issue.severity === "error");
  results.push({
    id: item.id,
    expectedBlock: item.expectedBlock,
    observedBlock: errors.length > 0,
    errorCodes: errors.map((issue) => issue.code),
    wallTimeMs: Math.round((performance.now() - started) * 100) / 100,
  });
  await rm(root, { recursive: true, force: true });
}

const truePositive = results.filter((item) => item.expectedBlock && item.observedBlock).length;
const trueNegative = results.filter((item) => !item.expectedBlock && !item.observedBlock).length;
const falsePositive = results.filter((item) => !item.expectedBlock && item.observedBlock).length;
const falseNegative = results.filter((item) => item.expectedBlock && !item.observedBlock).length;
const summary = {
  cases: results.length,
  truePositive,
  trueNegative,
  falsePositive,
  falseNegative,
  precision: truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive),
  recall: truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative),
  accuracy: (truePositive + trueNegative) / results.length,
  meanWallTimeMs: results.reduce((sum, item) => sum + item.wallTimeMs, 0) / results.length,
};

for (const result of results) console.log(JSON.stringify(result));
console.log(JSON.stringify({ summary }));
if (falsePositive > 0 || falseNegative > 0) process.exitCode = 1;

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-governance-bench-"));
  await mkdir(join(root, "src", "domain"), { recursive: true });
  await mkdir(join(root, "src", "adapters"), { recursive: true });
  await writeFile(join(root, "src", "domain", "order.js"), "export const order = 1;\n");
  await writeFile(join(root, "src", "adapters", "inventory.js"), "export const stock = 1;\n");
  await writeFile(join(root, ".devspace-architecture.json"), `${JSON.stringify(architectureIntent(), null, 2)}\n`);
  return root;
}

function architectureIntent() {
  return {
    version: 1 as const,
    project: "governance-engine-benchmark",
    policies: {
      acyclic: false,
      maxDepth: 12,
      dependencyRules: [
        { kind: "forbid_dependency" as const, from: "src/domain/**", to: "src/adapters/**" },
      ],
    },
    annotations: [],
  };
}
