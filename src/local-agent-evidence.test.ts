import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentEvidenceStore, captureAgentGit } from "./local-agent-evidence.js";

test("agent evidence is private, immutable and readable after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-agent-evidence-"));
  try {
    const store = new LocalAgentEvidenceStore(root);
    const id = "agt_12345678";
    const finished = store.save({
      agentId: id, provider: "antigravity", workspaceRoot: root, model: "gemini-test",
      startedAt: "2026-10-24T00:00:00.000Z", outcome: "completed",
      response: "DONE", items: [{ type: "tool.call", name: "read", result: "ok" }],
      gitBefore: {}, gitAfter: {},
    });
    assert.equal(finished.outcome, "completed");
    assert.equal(finished.itemCount, 1);
    assert.match(finished.sha256, /^[a-f0-9]{64}$/);
    const file = join(root, "agent-evidence", id, finished.ref + ".json");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, "agent-evidence", id)).mode & 0o777, 0o700);
    }
    const original = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(JSON.parse(original.itemsJson)[0].name, "read");
    assert.equal(new LocalAgentEvidenceStore(root).latest(id)?.ref, finished.ref);
    const failure = store.save({
      agentId: id, provider: "antigravity", workspaceRoot: root,
      startedAt: "2026-10-24T00:01:00.000Z", outcome: "failed",
      error: "PROVIDER_EXECUTION_ERROR",
    });
    assert.equal(store.latest(id)?.outcome, "failed");
    const failureFile = join(root, "agent-evidence", id, failure.ref + ".json");
    utimesSync(failureFile, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    unlinkSync(join(root, "agent-evidence", id, "latest"));
    assert.equal(new LocalAgentEvidenceStore(root).latest(id)?.ref, failure.ref,
      "crash before latest-pointer publication must preserve immutable evidence");
    assert.equal(store.read(id, finished.ref).answerPreview, "DONE");
    assert.equal(store.read(id, failure.ref).error, "PROVIDER_EXECUTION_ERROR");
    assert.throws(() => store.read(id, "../other"), /Invalid agent evidence reference/);
    assert.throws(() => store.latest("../escape"), /Invalid agent evidence owner/);
    assert.equal(captureAgentGit(root).head, undefined, "non-Git workspaces remain usable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
