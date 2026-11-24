import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../config.js";
import {
  localNodeRegistration,
  runtimeBuildFingerprint,
  sourceFingerprint,
  sourceProvenanceDrifted,
} from "./local-node.js";

test("local node advertises MCP mounts only when an enabled server is configured", () => {
  const base = {
    node: { alias: "gateway", labels: {} },
    toolMode: "codex",
    allowedRoots: ["/workspace"],
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
    mcp: { servers: [] },
  } as unknown as ServerConfig;
  const noMount = localNodeRegistration(base, { semanticAvailable: false, durableTasksAvailable: false });
  assert.equal(noMount.capabilities.features.includes("mcp.mount"), false);

  const mounted = localNodeRegistration({
    ...base,
    mcp: { servers: [{
      name: "agent-desktop", transport: "stdio", command: "agent-desktop", args: [],
      enabled: true, timeoutMs: 30_000, env: {},
    }] },
  }, { semanticAvailable: false, durableTasksAvailable: false });
  assert.equal(mounted.capabilities.features.includes("mcp.mount"), true);
});

test("runtime build fingerprint is stable and bounded", () => {
  const first = runtimeBuildFingerprint();
  const second = runtimeBuildFingerprint();
  assert.match(first, /^[0-9a-f]{20}$/);
  assert.equal(second, first);
});

test("source fingerprint is stable for the checkout", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.match(sourceFingerprint(root), /^[0-9a-f]{20}$/);
  assert.equal(sourceFingerprint(root), sourceFingerprint(root));
});

test("source drift detects build/checkout mismatch", () => {
  assert.equal(
    sourceProvenanceDrifted(
      { revision: "abc", fingerprint: "one", dirty: true },
      { revision: "abc", fingerprint: "one", dirty: true },
    ),
    false,
  );
  assert.equal(
    sourceProvenanceDrifted(
      { revision: "abc", fingerprint: "one", dirty: true },
      { revision: "abc", fingerprint: "two", dirty: true },
    ),
    true,
  );
  assert.equal(sourceProvenanceDrifted(undefined, { revision: "abc" }), undefined);
});
