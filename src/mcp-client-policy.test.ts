import assert from "node:assert/strict";
import test from "node:test";
import { isCodexMcpClient, SYNREX_EXPLICIT_SELECTION_RULE } from "./mcp-client-policy.js";

test("Codex-originated MCP identifiers are denied regardless of machine", () => {
  for (const value of ["codex", "Codex CLI", "openai-codex/1.2", "Codex Desktop", "codex-code-mode"]) {
    assert.equal(isCodexMcpClient({ registeredName: value }), true, value);
    assert.equal(isCodexMcpClient({ userAgent: value }), true, value);
    assert.equal(isCodexMcpClient({ initializeClientName: value }), true, value);
  }
});

test("ordinary ChatGPT clients and incidental strings do not match Codex", () => {
  for (const value of [undefined, "ChatGPT", "Claude Desktop", "codexchange", "Synrex", "other-client"]) {
    assert.equal(isCodexMcpClient({ registeredName: value, userAgent: value }), false);
  }
  assert.match(SYNREX_EXPLICIT_SELECTION_RULE, /only when the user explicitly requests Synrex/);
  assert.match(SYNREX_EXPLICIT_SELECTION_RULE, /request to use Codex/);
});
