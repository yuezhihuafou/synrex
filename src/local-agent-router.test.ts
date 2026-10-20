import assert from "node:assert/strict";
import test from "node:test";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import { isBoundedReadOnlyTask, routeAutoAgent } from "./local-agent-router.js";

const catalog: LocalAgentCatalog = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, available: true, usable: true },
    { id: "pi", enabled: true, available: true, usable: true },
  ],
  profiles: [{
    name: "local-operator",
    description: "local",
    provider: "pi",
    model: "devspace-local/qwen3.5-4b-q4km",
  }],
};

test("auto route sends bounded read-only inspection to local operator", () => {
  const route = routeAutoAgent(
    "Inspect package.json and report the package name. Do not edit files.",
    catalog,
  );
  assert.deepEqual(route, { target: "local-operator", reason: "bounded-read-only" });
});

test("auto route keeps mutations and architecture work on codex", () => {
  assert.equal(routeAutoAgent("Fix the failing parser test.", catalog).target, "codex");
  assert.equal(routeAutoAgent("Design the multi-node architecture.", catalog).target, "codex");
});

test("bounded read-only classifier is conservative", () => {
  assert.equal(isBoundedReadOnlyTask("Read src/config.ts and explain one constant."), true);
  assert.equal(isBoundedReadOnlyTask("Inspect package.json. Do not edit files."), true);
  assert.equal(isBoundedReadOnlyTask("Refactor src/config.ts and update tests."), false);
  assert.equal(isBoundedReadOnlyTask("Debug a production performance regression."), false);
});
