import assert from "node:assert/strict";
import test from "node:test";
import {
  MemHubMemoryAdapter, createOptionalProjectMemoryPort,
} from "./memhub-memory-adapter.js";

const endpoint = "http://127.0.0.1:3001/mcp";
const response = {
  resolvedProjectId: "synrex", recallScope: "global_and_project",
  projectMemory: [
    { id: "l3_1", content: "Use existing Workflow CAS", projectId: "synrex", evidenceRef: "l3:1@rev" },
    { id: "other", content: "secret other project", projectId: "robotics" },
  ],
  globalMemory: [{ id: "l4_1", content: "Keep replies concise" }],
  projectArchitecture: [{ id: "arch_1", content: "Historical note", projectId: "synrex" }],
};

test("MemHub adapter uses only bounded, explicitly scoped read calls", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const adapter = new MemHubMemoryAdapter({
    endpoint,
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === "memhub_memory") {
        return { content: [{ type: "text", text: JSON.stringify({ item: { content: "Exact original" } }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  });
  assert.equal((await adapter.recall({ project: "", query: "fix" })).status, "ambiguous");
  const result = await adapter.recall({ project: "synrex", query: "fix", maxBytes: 2000 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.items.some((item) => item.id === "other"), false);
  assert.equal(result.items[0].evidenceRef, "l3:1@rev");
  assert.equal(result.items.some((item) => item.source === "architecture_context"), true);
  assert.equal(calls[0].name, "memmy_context");
  assert.equal(calls[0].args.project, "synrex");
  assert.equal(calls[0].args.workspace_project, "synrex");
  assert.equal(calls[0].args.cross_project_skills, false);
  const hydration = await adapter.hydrate("l3:1@rev");
  assert.equal(hydration.status, "ok");
  if (hydration.status === "ok") assert.equal(hydration.content, "Exact original");
  assert.equal(calls[1].name, "memhub_memory");
  assert.deepEqual(calls[1].args, { action: "load", evidence_ref: "l3:1@rev" });
});

test("MemHub mismatch and downtime never become invented context", async () => {
  const wrong = new MemHubMemoryAdapter({
    endpoint, invoke: async () => ({ ...response, resolvedProjectId: "robotics" }),
  });
  assert.equal((await wrong.recall({ project: "synrex", query: "test" })).status, "ambiguous");
  const dead = new MemHubMemoryAdapter({
    endpoint, invoke: async () => { throw new Error("down"); },
  });
  assert.equal((await dead.recall({ project: "synrex", query: "test" })).status, "unavailable");
  const never = new MemHubMemoryAdapter({
    endpoint, timeoutMs: 500,
    invoke: async () => new Promise<never>(() => undefined),
  });
  const start = performance.now();
  assert.equal((await never.recall({ project: "synrex", query: "test" })).status, "unavailable");
  assert.ok(performance.now() - start < 2_000);
  assert.equal((await createOptionalProjectMemoryPort({}).recall({ project: "synrex", query: "test" })).status, "disabled");
  assert.throws(() => new MemHubMemoryAdapter({ endpoint: "http://example.com/mcp" }), /HTTPS/);
});
