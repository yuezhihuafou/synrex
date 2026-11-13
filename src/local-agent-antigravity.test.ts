import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityLocalAgentDriver } from "./local-agent-antigravity.js";

function isolatedAgyFixture(dir: string): { home: string; workspace: string } {
  // A mocked CLI must not rely on the developer's private login state.
  const home = join(dir, "home");
  const workspace = join(dir, "project");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, workspace };
}

test("AGY stream-json emits bounded events, records real usage and resumes by conversation ID",
  { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "synrex-agy-session-test-"));
  try {
    const { home, workspace } = isolatedAgyFixture(dir);
    const command = join(workspace, "agy-mock");
    const script = `#!/bin/sh
printf '%s\\n' "$@" > "${join(workspace, "args.log")}"
echo '{"event":"step_update","step_update":{"state":"DONE","conversation_id":"conv_123","usage":{"input_tokens":10,"output_tokens":2}}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"AGY OK","conversation_id":"conv_123","usage":{"input_tokens":10,"output_tokens":2,"thinking_tokens":1}}}'
`;
    writeFileSync(command, script);
    chmodSync(command, 0o755);
    const driver = new AntigravityLocalAgentDriver({ ...process.env, HOME: home, ANTIGRAVITY_COMMAND: command });
    const runtime = await driver.createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const events: string[] = [];
    const sessionIds: string[] = [];
    const first = await runtime.value.run({ prompt: "hello", workspaceRoot: workspace, writeMode: "read_only" }, {
      onEvent: (event) => { events.push(event.label); },
      onSessionId: (id) => { sessionIds.push(id); },
    });
    assert.equal(first.status, "ok");
    if (first.status === "ok") {
      assert.equal(first.value.finalResponse, "AGY OK");
      assert.equal(first.value.providerSessionId, "conv_123");
      assert.equal(first.value.usage?.inputTokens, 10);
      assert.equal(first.value.usage?.thinkingTokens, 1);
    }
    assert.deepEqual(events, ["step_update:DONE"]);
    assert.deepEqual(sessionIds, ["conv_123"]);
    const next = await runtime.value.run({
      prompt: "continue", workspaceRoot: workspace, providerSessionId: "conv_123", effort: "high",
    });
    assert.equal(next.status, "ok");
    const argumentsLog = readFileSync(join(workspace, "args.log"), "utf8");
    assert.match(argumentsLog, /--conversation\nconv_123\n/);
    assert.match(argumentsLog, /--effort\nhigh\n/);
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AGY API errors are failures, not successful empty turns",
  { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "synrex-agy-error-"));
  try {
    const { home, workspace } = isolatedAgyFixture(dir);
    const command = join(workspace, "agy-mock");
    writeFileSync(command, '#!/bin/sh\necho \'{"event":"result","result":{"status":"ERROR","error":"Provider rejected the request"}}\'\n');
    chmodSync(command, 0o755);
    const driver = new AntigravityLocalAgentDriver({ ...process.env, HOME: home, ANTIGRAVITY_COMMAND: command });
    const runtime = await driver.createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ prompt: "hello", workspaceRoot: workspace });
    assert.equal(result.status, "error");
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Antigravity preserves observed pretty JSON result and does not claim tool events",
  { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "synrex-agy-pretty-"));
  try {
    const { home, workspace } = isolatedAgyFixture(dir);
    const binary = join(workspace, "agy-mock");
    writeFileSync(binary, '#!/bin/sh\nprintf \'diagnostic\\n{\\n  "status": "SUCCESS",\\n  "response": "PRETTY_OK",\\n  "usage": {"total_tokens": 14}\\n}\\n\'\n');
    chmodSync(binary, 0o755);
    const runtime = await new AntigravityLocalAgentDriver({
      ...process.env, HOME: home, ANTIGRAVITY_COMMAND: binary,
    }).createRuntime();
    assert.equal(runtime.status, "ok");
    if (runtime.status !== "ok") return;
    const result = await runtime.value.run({ prompt: "test", workspaceRoot: workspace });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.value.finalResponse, "PRETTY_OK");
      assert.equal(result.value.items.length, 1);
      assert.equal((result.value.items[0] as { toolEventsObserved: boolean }).toolEventsObserved, false);
    }
    await runtime.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
