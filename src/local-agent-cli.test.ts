import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GenericCliAgentDriver } from "./local-agent-cli.js";
import { createLocalAgentDrivers } from "./local-agent-adapters.js";
import { subagentsConfigSchema } from "./local-agent-config.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import { resolveLocalAgentTarget } from "./local-agent-targets.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";

test("declarative CLI provider works without a vendor-specific adapter and retains provider sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-generic-cli-"));
  try {
    const executable = join(root, "sample-agent");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + join(root, "args.log") + '"\necho \'{"event":"step_update","step_update":{"state":"DONE","conversation_id":"session_abc"}}\'\necho \'{"event":"result","result":{"status":"SUCCESS","response":"done","conversation_id":"session_abc","usage":{"input_tokens":12,"output_tokens":4}}}\'\n');
    chmodSync(executable, 0o700);
    const config = subagentsConfigSchema.parse({
      enabled: true,
      providers: [{ id: "sample-agent", enabled: true, model: "small", cli: {
        command: executable,
        args: ["--output-format", "stream-json"],
        outputFormat: "stream-json",
        sessionFlag: "--session", modelFlag: "--model", promptFlag: "--print",
        successStatus: "SUCCESS",
      } }],
    });
    const available = getLocalAgentProviderAvailabilitySnapshot(process.env, config);
    const providerStatus = buildLocalAgentProviderStatuses(config, available).find((entry) => entry.id === "sample-agent");
    assert.equal(providerStatus?.usable, true);
    const target = resolveLocalAgentTarget("sample-agent", [], undefined, undefined, config.providers);
    assert.equal(target?.provider, "sample-agent");
    const driver = createLocalAgentDrivers({ subagents: config }).find((item) => item.provider === "sample-agent");
    assert.ok(driver);
    const runtime = await driver.createRuntime({ agentId: "agt_test", provider: "sample-agent", workspaceRoot: root });
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const events: string[] = [];
    const first = await runtime.value.run({ workspaceRoot: root, prompt: "begin", model: "small" }, {
      onEvent: (event) => { events.push(event.label); },
    });
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;
    assert.equal(first.value.providerSessionId, "session_abc");
    assert.equal(first.value.usage?.inputTokens, 12);
    assert.deepEqual(events, ["step_update:DONE"]);
    const continued = await runtime.value.run({
      workspaceRoot: root, prompt: "next", providerSessionId: first.value.providerSessionId ?? undefined,
    });
    assert.equal(continued.status, "ok");
    assert.match(readFileSync(join(root, "args.log"), "utf8"), /--session\nsession_abc\n/);
    const readonly = await runtime.value.run({ workspaceRoot: root, prompt: "no-write", writeMode: "read_only" });
    assert.equal(readonly.status, "error", "generic CLI must not pretend to enforce read-only without isolation");
    await runtime.value.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("JSON CLI errors and empty results are terminal failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-generic-error-"));
  try {
    const command = join(root, "agent-error");
    writeFileSync(command, '#!/bin/sh\necho \'{"status":"ERROR","error":"provider failure"}\'\n');
    chmodSync(command, 0o700);
    const driver = new GenericCliAgentDriver("sample-agent", {
      command, args: [], outputFormat: "json", successStatus: "SUCCESS",
    });
    const runtime = await driver.createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ workspaceRoot: root, prompt: "run" });
    assert.equal(result.status, "error");
    await runtime.value.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manager persists provider progress, real token usage and a resumable CLI session", async () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-cli-manager-"));
  try {
    const executable = join(root, "cli-mock");
    writeFileSync(executable, '#!/bin/sh\necho \'{"event":"step_update","step_update":{"state":"DONE","conversation_id":"conv_mgr"}}\'\necho \'{"event":"result","result":{"status":"SUCCESS","response":"finished","conversation_id":"conv_mgr","usage":{"input_tokens":22,"output_tokens":6}}}\'\n');
    chmodSync(executable, 0o700);
    const config = subagentsConfigSchema.parse({
      enabled: true,
      providers: [{ id: "cli-mock", enabled: true, cli: {
        command: executable, outputFormat: "stream-json", sessionFlag: "--session",
        successStatus: "SUCCESS",
      } }],
    });
    const store = new LocalAgentStore(join(root, "state"));
    const manager = new LocalAgentManager({
      store, subagents: config, loadProfiles: async () => [], allowedRoots: [root],
      pool: new LocalAgentRuntimePool(), drivers: createLocalAgentDrivers({ subagents: config }),
    });
    const scope = { workspaceId: "ws_cli_mock", workspaceRoot: root };
    try {
      const started = await manager.start({ target: "cli-mock", workspaceRoot: root, workspaceId: scope.workspaceId, prompt: "hello" });
      assert.equal(started.status, "ok");
      if (started.status !== "ok") return;
      const agentId = started.value.id;
      const awaitIdle = async () => {
        for (let i = 0; i < 150; i++) {
          const record = manager.get(agentId, scope);
          if (record.isErr()) throw record.error;
          if (record.value.status === "idle") return record.value;
          if (record.value.status === "error") throw new Error(record.value.error);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for CLI agent completion");
      };
      const record = await awaitIdle();
      assert.equal(record.providerSessionId, "conv_mgr");
      const eventResult = manager.events(agentId, scope);
      assert.equal(eventResult.status, "ok");
      if (eventResult.status === "ok") {
        assert.ok(eventResult.value.some((event) => event.kind === "progress"));
        assert.ok(eventResult.value.some((event) => event.kind === "session_saved"));
        assert.ok(eventResult.value.some((event) => event.kind === "turn_completed" && event.inputTokens === 22));
      }
      const stats = manager.stats(scope);
      assert.equal(stats.status, "ok");
      if (stats.status === "ok") {
        assert.equal(stats.value.turns, 1);
        assert.equal(stats.value.inputTokens, 22);
        assert.equal(stats.value.outputTokens, 6);
      }
      const next = await manager.continue(agentId, "follow up", {}, scope);
      assert.equal(next.status, "ok");
      await awaitIdle();
      const after = manager.stats(scope);
      assert.equal(after.status, "ok");
      if (after.status === "ok") assert.equal(after.value.turns, 2);
    } finally { await manager.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
