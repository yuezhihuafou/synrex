/**
 * Local-only concurrency regression for the shared-checkout writer gate.
 * Uses isolated temporary files. Not a ChatGPT RTT or production benchmark.
 * Retained from the audited gateway performance experiments.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "../src/apply-patch.js";
import { WorkspaceOperationGate } from "../src/workspace-operation-gate.js";

const callsPerConversation = 12;
const conversationCounts = [1, 2, 4, 8];

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round((sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) * 100) / 100;
}

async function benchmark(conversations: number, sharedCheckout: boolean) {
  const scratch = await mkdtemp(join(tmpdir(), "synrex-parallel-regression-"));
  const gate = new WorkspaceOperationGate();
  const latencyMs: number[] = [];
  const roots = Array.from(
    { length: sharedCheckout ? 1 : conversations },
    (_, i) => join(scratch, `repo-${i}`),
  );
  try {
    for (const root of roots) {
      await mkdir(root);
      await writeFile(join(root, "counter.txt"), "value=0\n");
    }
    const start = performance.now();
    const jobs = Array.from({ length: conversations }, (_, index) =>
      Array.from({ length: callsPerConversation }, () => {
        const root = roots[sharedCheckout ? 0 : index]!;
        const queuedAt = performance.now();
        return gate.run(root, "write", async () => {
          const current = Number((await readFile(join(root, "counter.txt"), "utf8"))
            .trim().slice("value=".length));
          await applyPatch(root, `*** Begin Patch\n*** Update File: counter.txt\n@@\n-value=${current}\n+value=${current + 1}\n*** End Patch`);
        }).then(() => latencyMs.push(performance.now() - queuedAt));
      }),
    ).flat();
    await Promise.all(jobs);
    const expected = callsPerConversation * (sharedCheckout ? conversations : 1);
    for (const root of roots) {
      const observed = (await readFile(join(root, "counter.txt"), "utf8")).trim();
      if (observed !== `value=${expected}`) {
        throw new Error(`Lost update in ${root}: observed ${observed}, expected ${expected}`);
      }
    }
    if (gate.queuedRoots !== 0) throw new Error("Workspace gate leaked queue entries");
    return {
      conversations,
      topology: sharedCheckout ? "shared-checkout" : "independent-worktrees",
      operations: jobs.length,
      failures: 0,
      wallMs: percentile([performance.now() - start], 1),
      p50Ms: percentile(latencyMs, 0.5),
      p95Ms: percentile(latencyMs, 0.95),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

for (const conversations of conversationCounts) {
  for (const sharedCheckout of [true, false]) {
    console.log(JSON.stringify(await benchmark(conversations, sharedCheckout)));
  }
}
