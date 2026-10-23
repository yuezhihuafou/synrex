import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityLocalAgentDriver } from "./local-agent-antigravity.js";

test("Antigravity adapter parses JSON and does not invent resumable sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synrex-agy-test-"));
  try {
    const command = join(dir, "agy-mock");
    writeFileSync(command, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"SUCCESS","response":"OK","conversation_id":"opaque"}\'\n');
    chmodSync(command, 0o755);
    const driver = new AntigravityLocalAgentDriver({ ...process.env, ANTIGRAVITY_COMMAND: command });
    const runtime = await driver.createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ prompt: "hello", workspaceRoot: dir, writeMode: "read_only" });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.value.finalResponse, "OK");
      assert.equal(result.value.providerSessionId, null);
    }
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Antigravity API errors remain failures, not successful empty responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synrex-agy-error-"));
  try {
    const command = join(dir, "agy-mock");
    writeFileSync(command, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ERROR","error":"User location is not supported for the API use."}\'\n');
    chmodSync(command, 0o755);
    const driver = new AntigravityLocalAgentDriver({ ...process.env, ANTIGRAVITY_COMMAND: command });
    const runtime = await driver.createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ prompt: "hello", workspaceRoot: dir });
    assert.equal(result.status, "error");
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
