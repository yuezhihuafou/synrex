import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CompletionMailbox, appendMailboxEvents, mailboxScope } from "./completion-mailbox.js";
import type { DurableTaskView } from "./durable-task-model.js";

const TASK = "task_0123456789abcdef";
function view(status: DurableTaskView["status"]): DurableTaskView {
  return {
    taskId: TASK, runId: "run_20261020093000_aabbccdd",
    status, revision: "aabbccdd", createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(), ttlMs: null, workspaceId: "ws_a",
    outputBytes: 0, outputLines: 0,
    result: status === "completed"
      ? { runId: "run_20261020093000_aabbccdd", isError: false, exitCode: 0,
        signal: null, outputBytes: 0, outputLines: 0 } : undefined,
  };
}

test("completion mailbox persists, isolates scope, dedupes, and allows acknowledgement", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synrex-mailbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scopeA = mailboxScope("conversation-A");
  const scopeB = mailboxScope("conversation-B");
  const first = new CompletionMailbox(dir);
  first.register("ws_a", scopeA, TASK);
  first.register("ws_a", scopeA, TASK);
  const restarted = new CompletionMailbox(dir);
  const lookup = async () => view("completed");
  assert.deepEqual(await restarted.collect("ws_b", scopeA, lookup), []);
  assert.deepEqual(await restarted.collect("ws_a", scopeB, lookup), []);
  const events = await restarted.collect("ws_a", scopeA, lookup);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.taskId, TASK);
  assert.equal(events[0]?.status, "completed");
  assert.equal(events[0]?.exitCode, 0);
  assert.deepEqual(await restarted.collect("ws_a", scopeA, lookup), []);

  const db = new Database(join(dir, "completion-mailbox.sqlite"));
  db.prepare("UPDATE mailbox_tasks SET delivered_at = ? WHERE task_id = ?")
    .run(Date.now() - 125_000, TASK);
  db.close();
  assert.equal((await first.collect("ws_a", scopeA, lookup)).length, 1);
  restarted.acknowledge("ws_a", scopeA, TASK);
  assert.deepEqual(await first.collect("ws_a", scopeA, lookup), []);
});

test("completion mailbox ignores running jobs and never sends raw logs or commands", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synrex-mailbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mailbox = new CompletionMailbox(dir);
  const scope = mailboxScope(undefined);
  mailbox.register("ws_a", scope, TASK);
  mailbox.register("ws_a", scope, "invalid_non_task");
  assert.deepEqual(await mailbox.collect("ws_a", scope, async () => view("working")), []);
  const completed = await mailbox.collect("ws_a", scope, async () => view("completed"));
  const original = {
    content: [{ type: "text", text: "original file content" }],
    structuredContent: { result: "original file content" },
  };
  const result = appendMailboxEvents(original, completed);
  assert.equal((result.structuredContent as Record<string, unknown>).sourceResult, original.structuredContent.result);
  assert.match(result.structuredContent.result, /task=task_0123456789abcdef status=completed/);
  assert.equal(result.content[0], original.content[0]);
  assert.equal(result.content.length, 2);
  assert.match(result.content[1]?.text ?? "", /Synrex Completion Mailbox/);
  assert.match(result.content[1]?.text ?? "", /task=task_0123456789abcdef status=completed/);
  assert.doesNotMatch(result.content[1]?.text ?? "", /original file content/);
  assert.equal(appendMailboxEvents({ ...original, isError: true }, completed).content.length, 1);
});

test("mailbox exposes status through structured result for six-tool clients and retains exact source", () => {
  const original = {
    content: [{ type: "text", text: "file contents\n" }],
    structuredContent: { result: "file contents\n" },
  };
  const event = { taskId: TASK, status: "completed" as const, runId: "run_20261020093000_aabbccdd", revision: "rev1", exitCode: 0 };
  const delivered = appendMailboxEvents(original, [event]);
  const fields = delivered.structuredContent as Record<string, unknown>;
  assert.equal(fields.sourceResult, original.structuredContent.result);
  assert.match(delivered.structuredContent.result, /Synrex task status \(not source content\)/);
  assert.match(delivered.structuredContent.result, new RegExp(TASK));
  assert.equal((fields.completionNotices as Array<{ taskId: string }>)[0]?.taskId, TASK);
  assert.equal(delivered.content[0]?.text, original.content[0]?.text);
  assert.deepEqual(original.structuredContent, { result: "file contents\n" });
  assert.equal(appendMailboxEvents(original, []).structuredContent.result, "file contents\n");
});
