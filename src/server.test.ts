import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { DurableTaskManager } from "./durable-tasks.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { LearningStore } from "./learning-store.js";
import { runDurableTask } from "./durable-task-runner.js";
import { SerenaSemanticManager } from "./serena-semantic.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { expectedToolNames } from "./tool-surface-manifest.js";
import { EXECUTION_OUTCOME_LOOP } from "./execution-outcome-loop.js";
import { FAILURE_CONTINUATION_HINT } from "./execution-outcome-loop.js";

const execFileAsync = promisify(execFile);

test("MCP initialization identifies Synrex and preserves the coding tool surface", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const server = context.client.getServerVersion();
  assert.equal(server?.name, "synrex");
  assert.equal(server?.title, "Synrex");
  assert.match(server?.description ?? "", /self-hosted, GPT-first coding and execution harness/);
  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "open_workspace"));
});

test("real MCP initialize delivers the goal-completion rule in both tool modes", async (t) => {
  for (const mode of ["codex", "claude"] as const) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const instruction = context.client.getInstructions() ?? "";
      assert.ok(instruction.includes(EXECUTION_OUTCOME_LOOP), `${mode} MCP initialize must deliver the rule`);
      assert.equal(instruction.split(EXECUTION_OUTCOME_LOOP).length, 2, "avoid duplicated instructions");
      assert.match(instruction, /default to the NEXT authorized action/);
      assert.match(instruction, /concrete external blocker or missing authority/);
      assert.match(instruction, /stop condition is the original observable acceptance criteria/);
    });
  }
});

test("MCP supports a controlled failed command -> repair -> verified goal sequence", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true, uiEnabled: false });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const cmd = "test -f recovered.txt && grep -qx recovered recovered.txt";
  const failed = await context.client.callTool({ name: "exec_command", arguments: { workspaceId, cmd } });
  assert.equal(failed.isError, true, "initial command must actually fail");
  assert.notEqual(structuredContent(failed).exitCode, 0);
  const repaired = await context.client.callTool({ name: "apply_patch", arguments: {
    workspaceId, patch: "*** Begin Patch\n*** Add File: recovered.txt\n+recovered\n*** End Patch",
  } });
  assert.notEqual(repaired.isError, true, "repair must be applied through the normal tool");
  const verified = await context.client.callTool({ name: "exec_command", arguments: { workspaceId, cmd } });
  assert.notEqual(verified.isError, true, "the original acceptance command should now pass");
  assert.equal(structuredContent(verified).exitCode, 0);
});

test("project learning can explicitly recall sibling ChatGPT worktree notes without granting cross-worktree promotion", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true, uiEnabled: false });
  const first = await context.client.callTool({
    name: "open_workspace", arguments: { path: context.project, mode: "worktree" },
  });
  const second = await context.client.callTool({
    name: "open_workspace", arguments: { path: context.project, mode: "worktree" },
  });
  assert.notEqual(first.isError, true, contentText(first));
  assert.notEqual(second.isError, true, contentText(second));
  const sourceId = structuredContent(first).workspaceId as string;
  const targetId = structuredContent(second).workspaceId as string;
  assert.notEqual(sourceId, targetId);
  const added = await context.client.callTool({
    name: "project", arguments: {
      workspaceId: sourceId, action: "learn_record",
      args: { taskKey: "cross-chat-recovery", title: "Cross-chat recovery lesson",
        summary: "Check task receipts before replaying uncertain commands.", outcome: "completed" },
    },
  });
  assert.notEqual(added.isError, true, contentText(added));
  const oldNoteId = structuredContent(added).noteId as string;
  const defaultRecall = await context.client.callTool({
    name: "project", arguments: {
      workspaceId: targetId, action: "learn_recall", args: { query: "recovery" },
    },
  });
  assert.doesNotMatch(contentText(defaultRecall), /Cross-chat recovery lesson/);
  const explicit = await context.client.callTool({
    name: "project", arguments: {
      workspaceId: targetId, action: "learn_recall",
      args: { query: "recovery", includeProjectWorktrees: true },
    },
  });
  assert.notEqual(explicit.isError, true, contentText(explicit));
  assert.match(contentText(explicit), /Cross-chat recovery lesson/);
  assert.deepEqual(structuredContent(explicit).relatedNoteIds, [oldNoteId]);
  const review = await context.client.callTool({
    name: "project", arguments: {
      workspaceId: targetId, action: "learn_review",
      args: { includeProjectWorktrees: true },
    },
  });
  assert.notEqual(review.isError, true, contentText(review));
  assert.match(contentText(review), /Cross-chat recovery lesson/);
  const promotion = await context.client.callTool({
    name: "project", arguments: {
      workspaceId: targetId, action: "learn_distill", args: { noteId: oldNoteId },
    },
  });
  assert.equal(promotion.isError, true, "read-only sibling recall must not grant write or promotion rights");
});

test("batch read preserves separate file ranges and existing single-file reads", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "a.ts"), "alpha\nbeta\n");
  await writeFile(join(context.project, "b.ts"), "gamma\n");
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const batch = await context.client.callTool({ name: "read", arguments: { workspaceId, files: [
    { path: "a.ts", offset: 2, limit: 1 }, { path: "b.ts" }, { path: "missing.ts" },
  ] } });
  const fields = structuredContent(batch) as { files: Array<{ path: string; result: string; isError: boolean }>; errorCount: number };
  assert.deepEqual(fields.files.map((file) => file.path), ["a.ts", "b.ts", "missing.ts"]);
  assert.match(fields.files[0]?.result ?? "", /beta/);
  assert.match(fields.files[1]?.result ?? "", /gamma/);
  assert.equal(fields.files[2]?.isError, true);
  assert.equal(fields.errorCount, 1);
  const original = await context.client.callTool({ name: "read", arguments: { workspaceId, path: "a.ts" } });
  assert.notEqual(original.isError, true);
  assert.match(String(structuredContent(original).result), /alpha/);
});

test("parallel MCP conversations preserve independent edits to the same checkout", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const a = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const b = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  assert.notEqual(a, b, "different conversations have distinct workspace identities");
  const count = 20;
  const original = Array.from({ length: count }, (_, i) => `unique-${i}`).join("\n") + "\n";
  await writeFile(join(context.project, "parallel.txt"), original);
  const results = await Promise.all(Array.from({ length: count }, (_, i) => context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: i % 2 ? a : b,
      patch: `*** Begin Patch\n*** Update File: parallel.txt\n@@\n-unique-${i}\n+changed-${i}\n*** End Patch`,
    },
  })));
  assert.equal(results.filter((result) => result.isError).length, 0);
  assert.equal(await readFile(join(context.project, "parallel.txt"), "utf8"),
    Array.from({ length: count }, (_, i) => `changed-${i}`).join("\n") + "\n");
});

test("MCP read delivers bounded visual evidence and preserves image blocks across batch reads", async t => {
  const context = await fixture(t);
  await copyFile(fileURLToPath(new URL("../docs/assets/v11-review-ui-before.png", import.meta.url)),
    join(context.project, "screenshot.png"));
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const single = await context.client.callTool({ name: "read", arguments: { workspaceId, path: "screenshot.png" } });
  assert.notEqual(single.isError, true);
  const image = (single.content as Array<{ type: string; data?: string; mimeType?: string }>)
    .find(item => item.type === "image");
  assert.ok(image && typeof image.data === "string");
  assert.equal(image.mimeType, "image/jpeg");
  assert.ok(Buffer.from(image.data, "base64").length <= 120_000);
  const meta = structuredContent(single).observation as { source: { kind: string; workspaceId: string }; previewOnly: boolean; imageCount: number };
  assert.equal(meta.source.kind, "file.image");
  assert.equal(meta.source.workspaceId, workspaceId);
  assert.equal(meta.previewOnly, true);
  assert.equal(meta.imageCount, 1);
  const batch = await context.client.callTool({
    name: "read", arguments: { workspaceId, files: [{ path: "screenshot.png" }] },
  });
  assert.notEqual(batch.isError, true);
  assert.equal((batch.content as Array<{ type: string }>).filter(item => item.type === "image").length, 1);
  const batchMeta = structuredContent(batch) as { observations: Array<{ path: string }> };
  assert.equal(batchMeta.observations[0]?.path, "screenshot.png");
  assert.ok(!JSON.stringify(structuredContent(batch)).includes(image.data));
});

test("MCP open_workspace records an actual chat title against a pseudonymous session", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const response = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, conversationTitle: "Synrex问题分析" },
    _meta: { "openai/session": "host-chat-session-for-test" },
  } as Parameters<Client["callTool"]>[0]);
  assert.notEqual(response.isError, true);
  const traces = new DiagnosticTrace(join(context.project, "..", ".state")).read({ minutes: 5 });
  const labeled = traces.find((entry) => entry.event === "conversation_labeled");
  assert.equal(labeled?.conversationTitle, "Synrex问题分析");
  assert.match(labeled?.conversationId ?? "", /^conv_[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(traces).includes("host-chat-session-for-test"));
});

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: expectedToolNames("claude"),
    },
    {
      mode: "codex",
      expected: expectedToolNames("codex"),
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("GPT coding workflow checkpoints are resumable through MCP after a new workspace opening", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const workspaceId = opened.workspaceId as string;
  const newWorkflow = await context.client.callTool({
    name: "workflow_open",
    arguments: {
      workspaceId, title: "P2 resume test", goal: "Build and verify a code change",
      acceptanceCriteria: ["Tests pass"], constraints: ["Do not deploy"],
      requestKey: "p2-test-retry-key",
    },
  });
  assert.notEqual(newWorkflow.isError, true);
  const created = structuredContent(newWorkflow);
  assert.match(contentText(newWorkflow), /Acceptance: Tests pass/);
  const workflowId = created.workflowId as string;
  assert.match(workflowId, /^wf_[a-f0-9]{24}$/);
  const replayedCreate = await context.client.callTool({
    name: "workflow_open",
    arguments: {
      workspaceId, title: "P2 resume test", goal: "Build and verify a code change",
      acceptanceCriteria: ["Tests pass"], constraints: ["Do not deploy"],
      requestKey: "p2-test-retry-key",
    },
  });
  assert.equal(structuredContent(replayedCreate).workflowId, workflowId);
  const unjustifiedCompletion = await context.client.callTool({
    name: "workflow_checkpoint",
    arguments: {
      workspaceId, workflowId, expectedRevision: 0, status: "completed",
      phase: "done", summary: "Claimed without verification",
      completedSteps: [], nextSteps: [], blockers: [], checks: [], taskIds: [],
    },
  });
  assert.equal(unjustifiedCompletion.isError, true);
  assert.match(contentText(unjustifiedCompletion), /without a recorded verification check/);
  const checkpoint = await context.client.callTool({
    name: "workflow_checkpoint",
    arguments: {
      workspaceId, workflowId, expectedRevision: 0, status: "active",
      phase: "testing", summary: "Implemented and starting tests",
      completedSteps: ["Implemented feature"], nextSteps: ["Read test output"],
      blockers: [], checks: ["pnpm typecheck: not run yet"],
      taskIds: ["task_0123456789abcdef"],
    },
  });
  assert.notEqual(checkpoint.isError, true);
  assert.equal(structuredContent(checkpoint).revision, 1);
  const learning = new LearningStore(join(context.project, "..", ".state"));
  const retrospective = learning.listNotes(context.project);
  assert.equal(retrospective.length, 1, "workflow checkpoint creates a durable retrospective");
  assert.equal(retrospective[0]?.outcome, "active");
  assert.match(retrospective[0]?.summary ?? "", /starting tests/);
  assert.deepEqual(retrospective[0]?.checks, ["pnpm typecheck: not run yet"]);
  const review = await context.client.callTool({
    name: "project", arguments: { workspaceId, action: "learn_review" },
  });
  assert.notEqual(review.isError, true);
  assert.match(contentText(review), /P2 resume test/);
  const captured = await context.client.callTool({
    name: "project", arguments: {
      workspaceId, action: "learn_record",
      args: { taskKey: "wait-for-test", title: "Avoid premature task completion",
        summary: "Pending commands do not prove a passing test.", outcome: "partial",
        rootCause: "Task handle only", lessons: ["Inspect terminal results."] },
    },
  });
  assert.notEqual(captured.isError, true, contentText(captured));
  assert.equal(learning.listNotes(context.project).length, 2);
  const noteId = structuredContent(captured).noteId as string;
  const noEvidence = await context.client.callTool({
    name: "project", arguments: { workspaceId, action: "learn_distill", args: { noteId } },
  });
  assert.equal(noEvidence.isError, true, "retrospective text alone is not a verified Skill");
  learning.recordToolCall({
    workspaceRoot: context.project, tool: "exec_command",
    toolInput: { cmd: "pnpm test" },
    toolOutput: { structuredContent: { running: false, exitCode: 0, result: "passed" } },
  });
  const passed = learning.recall(context.project, "pnpm test").episodes.find((ep) => ep.success);
  assert.ok(passed);
  const refined = await context.client.callTool({
    name: "project", arguments: {
      workspaceId, action: "learn_record", args: {
        taskKey: "wait-for-test", title: "Avoid premature task completion",
        summary: "Wait for a terminal command receipt.",
        outcome: "completed", rootCause: "Task handle only",
        resolution: ["Wait until the command finishes."],
        lessons: ["Inspect terminal results."],
        checks: ["pnpm test"],
        evidenceEpisodeIds: [passed.id],
      },
    },
  });
  assert.notEqual(refined.isError, true, contentText(refined));
  assert.equal(structuredContent(refined).noteId, noteId, "reflection updates are idempotent");
  const distilled = await context.client.callTool({
    name: "project", arguments: {
      workspaceId, action: "learn_distill", args: { noteId },
    },
  });
  assert.notEqual(distilled.isError, true, contentText(distilled));
  const candidateId = structuredContent(distilled).candidateId as string;
  const promoted = await context.client.callTool({
    name: "project", arguments: {
      workspaceId, action: "learn_promote", args: {
        candidateId, validationNote: "pnpm test passed in the selected workspace.",
      },
    },
  });
  assert.notEqual(promoted.isError, true, contentText(promoted));
  assert.match(contentText(promoted), /promoted to \.agents\/skills\//);
  // This test also asserts a clean Git handoff snapshot below. Verify the
  // materialized Skill, then remove only the test-created file.
  const skillPath = structuredContent(promoted).skillPath as string;
  await access(join(context.project, skillPath));
  await rm(join(context.project, skillPath));
  const restored = await context.client.callTool({
    name: "project", arguments: { workspaceId, action: "learn_recall", args: { query: "premature" } },
  });
  assert.match(contentText(restored), /Avoid premature task completion/);
  const stale = await context.client.callTool({
    name: "workflow_checkpoint",
    arguments: {
      workspaceId, workflowId, expectedRevision: 0, status: "active",
      phase: "testing", summary: "Old state", completedSteps: [], nextSteps: [], blockers: [], checks: [], taskIds: [],
    },
  });
  assert.equal(stale.isError, true);
  assert.match(contentText(stale), /revision conflict/);

  const reopened = structuredContent(await callOpen(context.client, context.project));
  assert.notEqual(reopened.workspaceId, workspaceId, "a new conversation/workspace session must still recover the workflow");
  const resumable = reopened.resumableWorkflows as Array<{ workflowId: string; revision: number }>;
  assert.ok(resumable.some((item) => item.workflowId === workflowId && item.revision === 1));
  const resume = await context.client.callTool({
    name: "workflow_open",
    arguments: { workspaceId: reopened.workspaceId, workflowId },
  });
  assert.equal(structuredContent(resume).revision, 1);
  const inspection = await context.client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: reopened.workspaceId, workflowId },
  });
  assert.match(contentText(inspection), /Goal: Build and verify a code change/);
  assert.match(contentText(inspection), /Acceptance: Tests pass/);
  assert.equal((structuredContent(inspection).history as unknown[]).length, 1);
  const handoff = structuredContent(inspection).handoff as {
    workspaceRoot: string;
    liveGit: { gitHead?: string; gitStatus?: string };
    checkpointGitMatchesCurrent: boolean | null;
    taskIdsToInspect: string[];
    checksAreSelfReported: boolean;
  };
  assert.equal(handoff.workspaceRoot, context.project);
  assert.match(handoff.liveGit.gitHead ?? "", /^[0-9a-f]{40}$/);
  assert.equal(handoff.checkpointGitMatchesCurrent, true);
  assert.deepEqual(handoff.taskIdsToInspect, ["task_0123456789abcdef"]);
  assert.equal(handoff.checksAreSelfReported, true);
  await writeFile(join(context.project, "changed-after-checkpoint.txt"), "new state\n");
  const changed = await context.client.callTool({
    name: "workflow_status",
    arguments: { workspaceId: reopened.workspaceId, workflowId },
  });
  const changedHandoff = structuredContent(changed).handoff as typeof handoff;
  assert.equal(changedHandoff.checkpointGitMatchesCurrent, false);
  assert.match(changedHandoff.liveGit.gitStatus ?? "", /changed-after-checkpoint.txt/);
});

test("workflow listing uses bounded concise model text with full structured evidence retained", async(t)=>{
  const context=await fixture(t,{toolMode:"codex",git:true});
  const workspaceId=structuredContent(await callOpen(context.client,context.project)).workspaceId as string;
  for(let i=0;i<8;i++){
    const created=await context.client.callTool({name:"workflow_open",arguments:{
      workspaceId, title:`Task ${i}`,goal:`Implement ${i} ${"specific requirement ".repeat(15)}`,
      acceptanceCriteria:["real output validated","regression passed"],constraints:["no unsafe retries"]
    }});
    assert.notEqual(created.isError,true);
  }
  const listed=await context.client.callTool({name:"workflow_status",arguments:{workspaceId}});
  const full=JSON.stringify(structuredContent(listed));
  const preview=contentText(listed);
  assert.match(preview,/next=/);
  assert.ok(Buffer.byteLength(preview)<Buffer.byteLength(full)/2,
    "model-facing response must be substantially smaller than full persisted records");
  assert.equal((structuredContent(listed).workflows as unknown[]).length,8);
});

test("project tool exposes a typed stable schema while retaining legacy args", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const tools = await context.client.listTools();
  const project = tools.tools.find((tool) => tool.name === "project");
  assert.ok(project);
  const properties = (project.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const required of ["workspaceId", "action", "target", "paths", "contracts", "dependencyRules", "detail", "args"]) {
    assert.ok(required in properties, `project schema should expose ${required}`);
  }
  const action = properties.action as { type?: unknown; enum?: unknown[] } | undefined;
  assert.equal(action?.type, "string");
  assert.equal(action?.enum, undefined, "project actions must stay open-ended so adding an action does not invalidate cached host schemas");
});

test("model-facing file mutation tools cannot bypass protected architecture intent", async (t) => {
  await t.test("codex apply_patch", async (nested) => {
    const context = await fixture(nested, { toolMode: "codex" });
    const opened = structuredContent(await callOpen(context.client, context.project));
    const response = await context.client.callTool({
      name: "apply_patch",
      arguments: {
        workspaceId: opened.workspaceId,
        patch: "*** Begin Patch\n*** Add File: .devspace-architecture.json\n+{}\n*** End Patch",
      },
    });
    assert.equal(response.isError, true);
    assert.match(contentText(response), /Architecture state is protected/);
  });

  await t.test("claude write", async (nested) => {
    const context = await fixture(nested, { toolMode: "claude" });
    const opened = structuredContent(await callOpen(context.client, context.project));
    const response = await context.client.callTool({
      name: "write",
      arguments: {
        workspaceId: opened.workspaceId,
        path: ".devspace-architecture.json",
        content: "{}\n",
      },
    });
    assert.equal(response.isError, true);
    assert.match(contentText(response), /Architecture state is protected/);
  });
});

test("codex process failures expose MCP error state and exit code", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: opened.workspaceId,
      cmd: "sh -c 'printf expected-error >&2; exit 7'",
      yieldTimeMs: 2_000,
    },
  });

  assert.equal(response.isError, true);
  assert.equal(structuredContent(response).exitCode, 7);
  assert.match(contentText(response), /expected-error/);
  assert.match(contentText(response), /acceptance criteria remain unmet/);
  assert.equal(structuredContent(response).result, contentText(response));
});

test("failed durable command is surfaced as error with a repair-next hint", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true, git: true });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const launched = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: "sleep 2; printf 'expected-build-error\\n'; exit 13" },
  });
  const taskId = structuredContent(launched).taskId as string;
  assert.match(taskId, /^task_[a-f0-9]{16}$/);
  const terminal = await context.client.callTool({ name: "task_wait", arguments: { workspaceId, taskId, final: true } });
  assert.equal(structuredContent(terminal).status, "completed");
  assert.equal(structuredContent(terminal).exitCode, 13);
  assert.equal(terminal.isError, true, "completed shell task with nonzero exit must not look successful");
  assert.match(contentText(terminal), /acceptance criteria remain unmet/);
  assert.match(contentText(terminal), /fix or alternative/);
  assert.match(contentText(terminal), /Final command failed \(exit 13\)/);
  assert.doesNotMatch(contentText(terminal), /Final dependency is completed/);
  const observed = await context.client.callTool({ name: "task_get", arguments: { workspaceId, taskId } });
  assert.equal(observed.isError, true);
  assert.ok(contentText(observed).includes(FAILURE_CONTINUATION_HINT));
});

test("codex process tools keep wait and output budgets server-managed", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const tools = await context.client.listTools();

  for (const name of ["exec_command", "task_get", "task_wait", "task_update", "task_cancel", "process_status", "write_stdin"]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} should be registered`);
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal("yieldTimeMs" in properties, false);
    assert.equal("maxOutputTokens" in properties, false);
  }
});

test("MCP task_get distinguishes output silence from runner heartbeat", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true, git: true });
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId as string;
  const launched = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: "printf 'begin\\n'; sleep 8; printf 'end\\n'" },
  });
  const taskId = structuredContent(launched).taskId as string;
  assert.match(taskId, /^task_[a-f0-9]{16}$/);
  await new Promise((resolve) => setTimeout(resolve, 5_400));
  const observed = await context.client.callTool({ name: "task_get", arguments: { workspaceId, taskId, detail: true } });
  const state = structuredContent(observed);
  assert.equal(state.status, "working");
  const detail = state.detail as { lastActivityAt?: string; lastUpdatedAt?: string };
  assert.equal(typeof detail.lastActivityAt, "string");
  assert.ok(Date.parse(detail.lastUpdatedAt as string) - Date.parse(detail.lastActivityAt as string) > 3_000,
    "task heartbeat should not reset time since stdout/stderr activity");
  const terminal = await context.client.callTool({ name: "task_wait", arguments: { workspaceId, taskId, final: true } });
  assert.equal(structuredContent(terminal).status, "completed");
  assert.equal(structuredContent(terminal).exitCode, 0);
});

test("completion mailbox relays a finished background job only in the originating chat scope", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true, git: true });
  const firstScope = "mailbox-chat-a";
  const opened = structuredContent(await callOpen(context.client, context.project, firstScope));
  const workspaceId = opened.workspaceId as string;
  const metaA = { "openai/session": firstScope };
  const start = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: "sleep 3; printf 'done\\n'" },
    _meta: metaA,
  } as Parameters<Client["callTool"]>[0]);
  const taskId = structuredContent(start).taskId as string;
  assert.match(taskId, /^task_[a-f0-9]{16}$/);
  await new Promise((resolve) => setTimeout(resolve, 3_250));

  const other = await context.client.callTool({
    name: "read", arguments: { workspaceId, path: "README.md" },
    _meta: { "openai/session": "mailbox-chat-b" },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(contentText(other), /Completion Mailbox/);

  const response = await context.client.callTool({
    name: "read", arguments: { workspaceId, path: "README.md" }, _meta: metaA,
  } as Parameters<Client["callTool"]>[0]);
  assert.match(contentText(response), /hello/);
  assert.match(contentText(response), /Synrex Completion Mailbox/);
  assert.match(contentText(response), new RegExp(taskId));
  assert.equal(structuredContent(response).sourceResult, "hello\n");
  assert.match(String(structuredContent(response).result), /Synrex Completion Mailbox/);
  const again = await context.client.callTool({
    name: "read", arguments: { workspaceId, path: "README.md" }, _meta: metaA,
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(contentText(again), /Completion Mailbox/);
});

test("six-tool clients can inspect bounded project evidence without a new tool schema or shell command", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true, git: true });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const workspaceId = opened.workspaceId as string;
  for (const [cmd, expected] of [
    ["devspace-project help", "read-only"],
    ["devspace-project learn-stats", "Learning:"],
    ["devspace-project learn-suggest", "No recent repeated"],
    ["devspace-project learn-recall test", "No relevant"],
  ]) {
    const response = await context.client.callTool({
      name: "exec_command", arguments: { workspaceId, cmd },
    });
    assert.match(contentText(response), new RegExp(expected, "i"));
    const fields = structuredContent(response);
    assert.equal(fields.readOnly, true);
    assert.equal(fields.taskId, undefined, "compat should not run as shell or launch durable work");
  }
  const missing = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: "devspace-project arch-validate" },
  });
  assert.match(contentText(missing), /not initialized/i);
  const rejected = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: "devspace-project learn-suggest; touch invalid" },
  });
  assert.equal(rejected.isError, true);
});

test("legacy final task command waits and reports a terminal final barrier receipt", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true, git: true });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const workspaceId = opened.workspaceId as string;
  const started = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "sleep 2; printf 'final-barrier-ok\\n'" },
  });
  const taskId = structuredContent(started).taskId as string;
  assert.match(taskId, /^task_[a-f0-9]{16}$/);
  const settled = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId, cmd: `devspace-task final ${taskId}` },
  });
  const result = structuredContent(settled);
  assert.equal(result.taskId, taskId);
  assert.equal(result.status, "completed");
  assert.equal((result.finalBarrier as { stage: string; nextCheckMs: number }).stage, "terminal");
  assert.equal((result.finalBarrier as { nextCheckMs: number }).nextCheckMs, 0);
  assert.match(contentText(settled), /verify the user's original acceptance criteria/);
});

test("codex tool surface stays compact without dropping capabilities", async (t) => {
  const semantic = new SerenaSemanticManager({
    available: true,
    createClient: async () => ({
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => undefined,
    }),
  });
  const context = await fixture(t, { toolMode: "codex", semantic });
  const tools = await context.client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const required of [
    "open_workspace", "read", "project", "apply_patch", "exec_command",
    "task_get", "task_wait", "task_update", "task_cancel", "process_status", "write_stdin",
    "semantic_code", "semantic_edit", "show_changes",
  ]) {
    assert.ok(names.includes(required), `${required} capability should remain exposed`);
  }
  const codexOwned = new Set([
    "apply_patch", "exec_command", "task_get", "task_wait", "task_update", "task_cancel",
    "process_status", "write_stdin", "semantic_code", "semantic_edit",
  ]);
  for (const tool of tools.tools.filter((candidate) => codexOwned.has(candidate.name))) {
    assert.equal(tool.outputSchema, undefined, `${tool.name} should not spend model context on redundant output schema`);
  }
  const totalBytes = tools.tools.reduce(
    (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool), "utf8"),
    0,
  );
  // Persistent workflow creation/status/checkpoint add three explicit tools.
  assert.ok(totalBytes <= 21_000, `Codex+Serena+workflow tool schema grew to ${totalBytes} bytes`);
  const opened = structuredContent(await callOpen(context.client, context.project));
  const semanticResponse = await context.client.callTool({
    name: "semantic_code",
    arguments: { workspaceId: opened.workspaceId, action: "find", path: "", symbol: "Example" },
  });
  assert.equal(contentText(semanticResponse), "ok");
  assert.equal(structuredContent(semanticResponse).result, "ok");
  await semantic.close();
});

test("codex common command responses stay compact and keep retrieval handles", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId: opened.workspaceId, cmd: "printf 'compact-ok\\n'" },
  });
  const structured = structuredContent(response);
  assert.equal(structured.exitCode, 0);
  assert.equal(typeof structured.runId, "string");
  assert.equal(structured.taskId, undefined);
  assert.equal(structured.result, contentText(response));
  assert.doesNotMatch(contentText(response), /devspace-log (?:meta|read|grep|tail)/);
  const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  assert.ok(bytes <= 500, `Common exec response grew to ${bytes} bytes`);
});

test("read defaults to bounded pagination without losing access to later lines", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const lines = Array.from({ length: 700 }, (_, index) => `line-${index + 1}`);
  await writeFile(join(context.project, "large.txt"), `${lines.join("\n")}\n`);
  const opened = structuredContent(await callOpen(context.client, context.project));
  const first = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: opened.workspaceId, path: "large.txt" },
  });
  const firstText = contentText(first);
  assert.match(firstText, /^line-1\n/);
  assert.match(firstText, /line-250/);
  assert.doesNotMatch(firstText, /line-251(?:\n|$)/);
  assert.match(firstText, /Use offset=251 to continue/);

  const second = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: opened.workspaceId, path: "large.txt", offset: 251, limit: 500 },
  });
  const secondText = contentText(second);
  assert.match(secondText, /^line-251\n/);
  assert.match(secondText, /line-700/);
});

test("open_workspace deduplicates only unchanged instructions within one conversation", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true });
  const conversationScopeId = "instruction-dedupe-scope";
  const initial = structuredContent(await callOpen(context.client, context.project, conversationScopeId));
  const initialFiles = initial.agentsFiles as Array<{ path: string; content: string }> | undefined;
  assert.ok(initialFiles?.some((file) => file.path === "AGENTS.md" && file.content === "project instructions\n"));

  const unchangedWorktree = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree" },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const unchanged = structuredContent(unchangedWorktree);
  const unchangedFiles = unchanged.agentsFiles as Array<{ path: string; content: string }> | undefined;
  assert.equal(unchangedFiles?.some((file) => file.path === "AGENTS.md"), false);
  assert.match(contentText(unchangedWorktree), /Unchanged workspace instructions already loaded in this conversation remain in force/);
  assert.match(contentText(unchangedWorktree), /read those paths before continuing/);

  await writeFile(join(context.project, "AGENTS.md"), "changed project instructions\n");
  await git(context.project, ["add", "AGENTS.md"]);
  await git(context.project, ["commit", "-m", "Change instructions"]);
  const changedWorktree = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree" },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const changed = structuredContent(changedWorktree);
  const changedFiles = changed.agentsFiles as Array<{ path: string; content: string }> | undefined;
  assert.ok(changedFiles?.some((file) => file.path === "AGENTS.md" && file.content === "changed project instructions\n"));
});

test("codex devspace-log responses satisfy the process output schema", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  const command = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "printf 'log-probe\\n'" },
  });
  const runId = structuredContent(command).runId;
  assert.equal(typeof runId, "string");

  const previousRunRoot = process.env.DEVSPACE_COMPACT_RUN_ROOT;
  process.env.DEVSPACE_COMPACT_RUN_ROOT = join(context.project, "..", ".runs");
  try {
    const log = await context.client.callTool({
      name: "exec_command",
      arguments: { workspaceId, cmd: `devspace-log meta ${runId}` },
    });
    const structured = structuredContent(log);
    assert.equal(structured.runId, runId);
    assert.equal(structured.running, false);
    assert.equal(structured.wallTimeMs, 0);
    assert.equal(typeof structured.outputBytes, "number");
    assert.equal("idleTimeMs" in structured, false);
    assert.equal("nextPollMs" in structured, false);
  } finally {
    if (previousRunRoot === undefined) delete process.env.DEVSPACE_COMPACT_RUN_ROOT;
    else process.env.DEVSPACE_COMPACT_RUN_ROOT = previousRunRoot;
  }
});

test("codex durable task compatibility tools expose an MCP-like lifecycle", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true });
  const opened = structuredContent(await callOpen(context.client, context.project, "task-lifecycle-a"));
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  const command = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "console.log('task-tool-ok')"`,
    },
  });
  const commandState = structuredContent(command);
  assert.equal(commandState.taskId, undefined);
  assert.equal(commandState.status, undefined);
  assert.equal(typeof commandState.runId, "string");

  const afterSynchronousResult = structuredContent(await callOpen(context.client, context.project, "task-lifecycle-sync"));
  assert.equal(afterSynchronousResult.pendingTasks, undefined);

  assert.ok(context.durableTasks);
  const asyncSnapshot = await context.durableTasks.start({
    workspaceId: workspaceId as string,
    workspaceRoot: context.project,
    cwd: context.project,
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('async-task-ok'), 120)"`,
  }, 5);
  assert.ok(asyncSnapshot.taskId);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const reopened = structuredContent(await callOpen(context.client, context.project, "task-lifecycle-b"));
  const resumedWorkspaceId = reopened.workspaceId;
  assert.equal(typeof resumedWorkspaceId, "string");
  assert.notEqual(resumedWorkspaceId, workspaceId);
  assert.equal(reopened.pendingTaskCount, 1);
  const pending = reopened.pendingTasks as Array<Record<string, unknown>> | undefined;
  assert.ok(pending?.some((task) => task.taskId === asyncSnapshot.taskId));
  assert.equal("root" in (pending?.[0] ?? {}), false);
  assert.equal("schemaVersion" in (pending?.[0] ?? {}), false);
  assert.equal("statusMessage" in (pending?.[0] ?? {}), false);
  assert.equal("runId" in (pending?.[0] ?? {}), false);
  assert.equal("lastUpdatedAt" in (pending?.[0] ?? {}), false);

  const task = await context.client.callTool({
    name: "task_get",
    arguments: { workspaceId: resumedWorkspaceId, taskId: asyncSnapshot.taskId },
  });
  const taskState = structuredContent(task);
  assert.equal(taskState.status, "completed");
  assert.equal(taskState.isError, false);

  const acknowledged = structuredContent(await callOpen(context.client, context.project, "task-lifecycle-c"));
  assert.equal(acknowledged.pendingTasks, undefined);
  assert.equal(acknowledged.pendingTaskCount, undefined);
});

test("known long codex commands detach early instead of occupying the MCP request", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true });
  const opened = structuredContent(await callOpen(context.client, context.project, "task-early-detach"));
  const startedAt = performance.now();
  const response = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId: opened.workspaceId, cmd: "sleep 3" },
  });
  const elapsedMs = performance.now() - startedAt;
  const state = structuredContent(response);
  assert.equal(typeof state.taskId, "string");
  assert.ok(elapsedMs < 2_500, `expected early detach, got ${Math.round(elapsedMs)}ms`);
  assert.ok((state.pollIntervalMs as number) > 0);
  const recoveryOpen = structuredContent(await callOpen(context.client, context.project, "task-early-detach-recover"));
  const activeHandles = recoveryOpen.activeTasks as Array<{ taskId: string; status: string }> | undefined;
  assert.ok(activeHandles?.some((task) => task.taskId === state.taskId && task.status === "working"),
    "a new conversation must identify executing commands separately from completed receipts");
  assert.equal(recoveryOpen.pendingTaskCount, undefined);
  assert.match(
    contentText(response),
    new RegExp(`devspace-task wait ${state.taskId as string}`),
  );
  const compatPoll = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: opened.workspaceId,
      cmd: `devspace-task get ${state.taskId as string}`,
    },
  });
  const compatState = structuredContent(compatPoll);
  assert.equal(compatState.taskId, state.taskId);
  assert.ok(compatState.status === "working" || compatState.status === "completed");
  assert.ok(context.durableTasks);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = await context.durableTasks.get(context.project, state.taskId as string, { acknowledge: false });
    if (task.status !== "working" && task.status !== "input_required") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("durable task wire stays compact and suppresses unchanged polling per conversation", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true });
  const opened = structuredContent(await callOpen(context.client, context.project, "compact-task-wire"));
  const started = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId: opened.workspaceId, cmd: "sleep 2" },
  });
  const initial = structuredContent(started);
  assert.match(initial.taskId as string, /^task_[0-9a-f]{16}$/i);
  assert.equal("createdAt" in initial, false);
  assert.equal("lastUpdatedAt" in initial, false);
  assert.equal("ttlMs" in initial, false);
  assert.equal(typeof initial.outputBytes, "number");
  assert.equal(typeof initial.outputLines, "number");
  assert.equal(typeof initial.outputTruncated, "boolean");
  assert.ok(Buffer.byteLength(JSON.stringify(started), "utf8") <= 550);

  const taskId = initial.taskId as string;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const meta = { "openai/session": "compact-task-poll" };
  const first = await context.client.callTool({
    name: "task_get",
    arguments: { workspaceId: opened.workspaceId, taskId },
    _meta: meta,
  } as Parameters<Client["callTool"]>[0]);
  const firstState = structuredContent(first);
  assert.equal(typeof firstState.revision, "string");
  assert.equal("createdAt" in firstState, false);
  assert.equal("lastUpdatedAt" in firstState, false);
  assert.equal("ttlMs" in firstState, false);

  const second = await context.client.callTool({
    name: "task_get",
    arguments: { workspaceId: opened.workspaceId, taskId },
    _meta: meta,
  } as Parameters<Client["callTool"]>[0]);
  const secondState = structuredContent(second);
  assert.equal(secondState.unchanged, true);
  assert.equal(secondState.revision, firstState.revision);
  assert.ok(Buffer.byteLength(JSON.stringify(second), "utf8") <= 350);

  const detailed = await context.client.callTool({
    name: "task_get",
    arguments: { workspaceId: opened.workspaceId, taskId, detail: true },
    _meta: meta,
  } as Parameters<Client["callTool"]>[0]);
  const detail = structuredContent(detailed).detail as Record<string, unknown> | undefined;
  assert.ok(detail);
  assert.equal(typeof detail.createdAt, "string");
  assert.equal(typeof detail.lastUpdatedAt, "string");
  assert.equal(typeof detail.outputBytes, "number");

  assert.ok(context.durableTasks);
  await context.durableTasks.cancel(context.project, taskId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = await context.durableTasks.get(context.project, taskId, { acknowledge: false });
    if (view.status !== "working" && view.status !== "input_required") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("task_wait completes durable commands without repeated host polling", async (t) => {
  const context = await fixture(t, { toolMode: "codex", durableTasks: true });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const start = await context.client.callTool({
    name: "exec_command",
    arguments: { workspaceId: opened.workspaceId, cmd: "sleep 2; printf 'wait-completed\\n'" },
  });
  const taskId = structuredContent(start).taskId as string;
  assert.match(taskId, /^task_[0-9a-f]{16}$/);
  const sixToolWait = await context.client.callTool({
    name: "exec_command", arguments: { workspaceId: opened.workspaceId, cmd: `devspace-task wait ${taskId}` },
  });
  const sixToolResult = structuredContent(sixToolWait);
  assert.equal(sixToolResult.taskId, taskId);
  assert.equal(sixToolResult.status, "completed");
  assert.equal(sixToolResult.exitCode, 0);
  assert.equal(sixToolResult.runId, structuredContent(start).runId);
  assert.match(sixToolResult.result as string, /wait-completed/);
  assert.equal(sixToolResult.outputTruncated, false);
  const waited = await context.client.callTool({
    name: "task_wait", arguments: { workspaceId: opened.workspaceId, taskId },
  });
  const result = structuredContent(waited);
  assert.equal(result.taskId, taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.unchanged, undefined);
  assert.match(result.result as string, /wait-completed/);
  const terminal = await context.client.callTool({
    name: "task_wait", arguments: { workspaceId: opened.workspaceId, taskId, sinceRevision: result.revision },
  });
  assert.equal(structuredContent(terminal).status, "completed");
  assert.equal(structuredContent(terminal).unchanged, undefined);

  const failed = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: opened.workspaceId,
      cmd: "sleep 2; node -e 'process.stderr.write(\"E\".repeat(4096))'; exit 7",
    },
  });
  const failedTaskId = structuredContent(failed).taskId as string;
  assert.match(failedTaskId, /^task_[0-9a-f]{16}$/);
  const failedWait = await context.client.callTool({
    name: "task_wait", arguments: { workspaceId: opened.workspaceId, taskId: failedTaskId },
  });
  const failedReceipt = structuredContent(failedWait);
  assert.equal(failedReceipt.exitCode, 7);
  assert.equal(failedReceipt.outputTruncated, true);
  assert.match(failedReceipt.result as string, /Task output tail \(truncated\)/);
  assert.match(failedReceipt.result as string, /Full log: devspace-log tail/);
  assert.ok((failedReceipt.result as string).length < 2_500);
});

test("project tool keeps architecture results compact unless detail is requested", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  await writeFile(join(context.project, "src", "b.ts"), "export const b = 1;\n");
  const opened = structuredContent(await callOpen(context.client, context.project, "project-wire"));
  await context.client.callTool({
    name: "project",
    arguments: { workspaceId: opened.workspaceId, action: "arch_init" },
  });

  const compact = await context.client.callTool({
    name: "project",
    arguments: {
      workspaceId: opened.workspaceId,
      action: "arch_affected",
      args: { paths: ["src/b.ts"] },
    },
  });
  const compactState = structuredContent(compact);
  assert.deepEqual(compactState.moduleIds, ["group:src", "file:src/a", "file:src/b"]);
  assert.equal("modules" in compactState, false);
  assert.equal("detail" in compactState, false);

  const detailed = await context.client.callTool({
    name: "project",
    arguments: {
      workspaceId: opened.workspaceId,
      action: "arch_affected",
      args: { paths: ["src/b.ts"], detail: true },
    },
  });
  const detail = structuredContent(detailed).detail as { modules?: unknown[] } | undefined;
  assert.equal(detail?.modules?.length, 3);
});

test("show_changes blocks deterministic architecture violations without blocking ordinary new files", async (t) => {
  const context = await fixture(t, { toolMode: "codex", git: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(context.project, "src", "b.ts"), "export const b = 2;\n");
  await git(context.project, ["add", "src/a.ts", "src/b.ts"]);
  await git(context.project, ["commit", "-m", "Add architecture fixture"]);
  const opened = structuredContent(await callOpen(context.client, context.project, "architecture-review"));
  const workspaceId = opened.workspaceId as string;

  await context.client.callTool({
    name: "project",
    arguments: { workspaceId, action: "arch_init" },
  });
  const openedChange = structuredContent(await context.client.callTool({
    name: "project",
    arguments: {
      workspaceId,
      action: "arch_change_open",
      intent: "Protect a from b",
      architectureChange: true,
      rationale: "Keep this dependency boundary deterministic.",
    },
  }));
  await context.client.callTool({
    name: "project",
    arguments: {
      workspaceId,
      action: "arch_policy",
      changeId: openedChange.changeId,
      dependencyRules: [{ kind: "forbid_dependency", from: "src/a.ts", to: "src/b.ts" }],
    },
  });
  await context.client.callTool({
    name: "project",
    arguments: { workspaceId, action: "arch_change_close", changeId: openedChange.changeId },
  });

  await writeFile(join(context.project, "src", "c.ts"), "export const c = 3;\n");
  const ordinary = await context.client.callTool({ name: "show_changes", arguments: { workspaceId } });
  assert.equal(ordinary.isError, undefined);

  await writeFile(join(context.project, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
  const violating = await context.client.callTool({ name: "show_changes", arguments: { workspaceId } });
  assert.equal(violating.isError, true);
  assert.match(contentText(violating), /Architecture conformance failed/);
  assert.match(contentText(violating), /forbidden-dependency/);
  const violatingCard = (violating._meta as {
    card?: { payload?: { patch?: string } };
  } | undefined)?.card;
  assert.match(violatingCard?.payload?.patch ?? "", /import \{ b \}/);

  const repeatedViolation = await context.client.callTool({ name: "show_changes", arguments: { workspaceId } });
  assert.equal(repeatedViolation.isError, true);
  const repeatedCard = (repeatedViolation._meta as {
    card?: { payload?: { patch?: string } };
  } | undefined)?.card;
  assert.match(repeatedCard?.payload?.patch ?? "", /import \{ b \}/);
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspaceId, workspaceId);
  assert.match(structured.reviewRef as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspaceId" in outputProperties);
  assert.ok(outputProperties && "reviewRef" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  const reviewRef = first.reviewRef;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).reviewRef, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# Synrex subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# Synrex subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspaceId, structuredContent(first).workspaceId);
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.notEqual(structuredContent(otherSession).workspaceId, structuredContent(first).workspaceId);
  assert.notEqual(structuredContent(unscoped).workspaceId, structuredContent(first).workspaceId);
  assert.ok(Array.isArray(structuredContent(otherSession).agentsFiles));
  assert.ok(Array.isArray(structuredContent(unscoped).agentsFiles));
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspaceId?: string; agentsFiles?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspaceId?: string; agentsFiles?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspaceId, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agentsFiles, undefined);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);

  // Trace the actual HTTP request lifecycle rather than equating a completed
  // tool handler with a delivered HTTP/MCP response.
  const entries = new DiagnosticTrace(join(root, ".state")).read({ minutes: 5, limit: 200 });
  const received = entries.filter((entry) => entry.event === "mcp_received");
  const handlerReturned = entries.filter((entry) => entry.event === "mcp_handler_returned");
  const finished = entries.filter((entry) => entry.event === "mcp_finished");
  assert.ok(received.some((entry) => entry.method === "POST"));
  assert.ok(handlerReturned.length > 0, "MCP handler completion must be separately observable");
  assert.ok(finished.some((entry) => entry.method === "POST" && entry.status === 200));
  assert.ok(finished.every((entry) => ["json", "sse", "unknown"].includes(entry.responseMode ?? "unknown")));
});

test("HTTP tracing starts before body upload, covers auth and parser failures", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(t, "synrex-http-chain-");
  const { request } = await import("node:http");
  const d = new DiagnosticTrace(join(root, ".state"));
  const body = JSON.stringify({ jsonrpc: "2.0", id: "private-rpc-label", method: "tools/list", params: {} });
  let finishBody: () => void = () => {};
  const result = new Promise<{ requestId: string; status: number }>((resolve, reject) => {
    const req = request(`${localBaseUrl}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body),
    } }, (res) => {
      res.resume();
      res.once("end", () => resolve({ requestId: String(res.headers["x-synrex-request-id"]), status: res.statusCode! }));
    });
    req.once("error", reject);
    req.write(body.slice(0, 10));
    finishBody = () => req.end(body.slice(10));
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const beforeBody = d.read({ limit: 200 });
  assert.ok(beforeBody.some((x) => x.event === "mcp_received"));
  assert.ok(!beforeBody.some((x) => x.event === "mcp_body_ready"));
  finishBody();
  const response = await result;
  assert.equal(response.status, 200);
  const chain = d.read({ requestId: response.requestId, limit: 200 });
  assert.ok((chain.find((x) => x.event === "mcp_body_ready")?.durationMs ?? 0) >= 50);
  assert.ok(chain.some((x) => x.event === "stage_finished" && x.stage === "auth"));
  assert.ok(chain.some((x) => x.event === "mcp_finished"));
  assert.ok(!JSON.stringify(chain).includes("private-rpc-label"));
  const malformed = await fetch(`${localBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"secret": broken' });
  assert.equal(malformed.status, 400);
  const failed = d.read({ requestId: malformed.headers.get("x-synrex-request-id")!, limit: 200 });
  assert.ok(failed.some((x) => x.event === "mcp_failed" && x.errorCategory === "protocol"));
  assert.ok(failed.some((x) => x.event === "mcp_finished" && x.status === 400));
  const aborted = request(`${localBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "content-length": 300 } });
  aborted.on("error", () => {});
  aborted.write('{"jsonrpc":');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const abortId = d.read({ limit: 200 }).filter((x) => x.event === "mcp_received").at(-1)?.requestId;
  assert.ok(abortId);
  aborted.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(d.read({ requestId: abortId, limit: 200 }).some((x) => x.event === "mcp_closed_early" && x.stage === "body"));
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspaceId?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspaceId,
        cmd: `node -e \"${command}\"`,
        yieldTimeMs: 30_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

interface ServerFixture {
  client: Client;
  project: string;
  durableTasks?: DurableTaskManager;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
  }));
  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
    durableTasks?: boolean;
    semantic?: SerenaSemanticManager;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    // Keep the MCP diagnostics/learning store isolated from the real user's
    // default state directory, alongside this fixture's workspace store.
    stateDir,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const durableRunners = new Set<Promise<number>>();
  const durableTasks = options.durableTasks
    ? new DurableTaskManager({
        runRoot: join(root, ".runs"),
        runnerPath: "test-runner",
        launchTask: async ({ requestPath }) => {
          const runner = runDurableTask(requestPath).finally(() => {
            durableRunners.delete(runner);
          });
          durableRunners.add(runner);
        },
      })
    : undefined;
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager({ runRoot: join(root, ".runs") }),
    resolveLocalAgentProviders,
    [],
    undefined,
    durableTasks,
    options.semantic,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    await Promise.allSettled([...durableRunners]);
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, durableTasks };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function contentText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object"
      && item !== null
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
