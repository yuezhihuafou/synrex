import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityLocalAgentDriver } from "./local-agent-antigravity.js";

test("Antigravity mock accepts pretty-printed multi-line CLI JSON after diagnostics", async t => {
  if (process.platform === "win32") return t.skip("POSIX fixture executable");
  const dir = mkdtempSync(join(tmpdir(), "synrex-antigravity-multiline-"));
  try {
    // The mock must not depend on a developer's private AGY login state.
    const home = join(dir, "home"), workspace = join(dir, "project");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const binary = join(workspace, "agy-mock");
    writeFileSync(binary, '#!/bin/sh\nprintf \'diagnostic\\n{\\n  "status": "SUCCESS",\\n  "response": "PRETTY_OK"\\n}\\n\'\n');
    chmodSync(binary, 0o755);
    const runtime = await new AntigravityLocalAgentDriver({
      ...process.env, HOME: home, ANTIGRAVITY_COMMAND: binary,
    }).createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ prompt: "test", workspaceRoot: workspace });
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.value.finalResponse, "PRETTY_OK");
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
