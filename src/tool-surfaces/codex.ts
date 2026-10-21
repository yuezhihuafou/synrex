import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { handleRunLogCommand } from "../compact-runtime/run-log-access.js";
import { compactPreview } from "../compact-runtime/output-policy.js";
import { waitForTaskChange } from "../durable-task-wait.js";
import type { TaskWaitResult } from "../durable-task-wait.js";
import { finalBarrierReceipt } from "../task-final-barrier.js";
import { ArchitectureModelManager } from "../architecture-model.js";
import { LearningStore } from "../learning-store.js";
import type { DurableTaskView } from "../durable-task-model.js";
import type { ProcessSnapshot, ProcessStatusSnapshot } from "../process-sessions.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  logToolCall,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_EXEC_YIELD_MS = 2_000;
const CODEX_LONG_EXEC_YIELD_MS = 1_000;
const CODEX_INTERACTIVE_YIELD_MS = 250;

function execYieldMs(command: string): number {
  const likelyLong = /(?:^|[;&|]\s*)(?:sleep\s+\d|(?:pnpm|npm|yarn|bun)\s+(?:test|build|typecheck|lint|check|run\s+(?:test|build|typecheck|lint|check)|tsx\s+--test\b)|(?:node|tsx)\s+--test\b|pytest\b|colcon\s+(?:build|test)\b|cmake\s+--build\b|(?:make|ninja)\b|cargo\s+(?:test|build|clippy)\b|go\s+test\b|mvn\b|gradle\b)/i.test(command);
  return likelyLong ? CODEX_LONG_EXEC_YIELD_MS : CODEX_EXEC_YIELD_MS;
}

const CODEX_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, apply_patch for file changes, and exec_command for commands. Batch independent inspections or checks when safe; never skip validation. Long commands return durable taskId/runId handles. While waiting, do useful independent work: a completed local command may announce itself in a later same-workspace tool response (Completion Mailbox); verify task_get before using it. At the final dependency use task_wait(final=true), or 'devspace-task final <taskId>' in a six-tool host, for a bounded final barrier; after 60s inspect logs/checkpoint, never assume success or silently replay. Ordinary waits use task_wait or 'devspace-task wait <taskId>' (8s max); status uses task_get or 'devspace-task get <taskId>'; task_cancel cancels. Six-tool clients can inspect project memory/architecture read-only with 'devspace-project learn-suggest', 'devspace-project learn-recall QUERY', 'devspace-project learn-stats', and 'devspace-project arch-validate'; never claim memory promotion or architectural approval from these reads. No wait or mailbox can wake GPT after its turn ends. task_update is reserved for protocol compatibility. Retrieve logs with devspace-log meta/read/tail/grep; use meta-full only for deep diagnostics. Interactive sessionId uses process_status/write_stdin. Commands are not sandboxed. Honor explicit user deployment targets: QA-only is not production. Follow ${toolNames.openWorkspace} instructions and applicable instruction/skill files.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) register(context);
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerSemanticTools,
  registerCodexProcessTools,
];

const semanticReadActionSchema = z.enum([
  "overview",
  "find",
  "references",
  "implementations",
  "declaration",
  "diagnostics",
]);

function registerSemanticTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, semantic } = context;

  server.registerTool(
    "semantic_code",
    {
      title: "Semantic code query",
      description:
        "Serena/LSP code queries: overview, find, references, implementations, declaration, diagnostics. Results are bounded; narrow broad searches.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        action: semanticReadActionSchema,
        path: z.string().describe("Workspace-relative source file or directory. Use an empty string only for a broad symbol find."),
        symbol: z.string().optional().describe("Symbol/name-path for find, references, or implementations."),
        pattern: z.string().optional().describe("Regex containing one capture group for declaration lookup."),
        detail: z.enum(["location", "info", "body"]).optional().describe("Find/declaration detail. Defaults to location."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, action, path: relativePath, symbol, pattern, detail }) => {
      const startedAt = performance.now();
      if (!semantic?.available) {
        throw new Error("Semantic code intelligence is unavailable on this host. Install/configure Serena; the tool remains registered so the MCP schema stays stable across restarts.");
      }
      const workspace = await workspaces.getWorkspace(workspaceId);
      if (relativePath) workspaces.resolveReadPath(workspace, relativePath);
      let tool: string;
      let args: Record<string, unknown>;
      if (action === "overview") {
        tool = "get_symbols_overview";
        args = { relative_path: relativePath, max_answer_chars: 6_000 };
      } else if (action === "find") {
        if (!symbol) throw new Error("semantic_code action=find requires symbol.");
        tool = "find_symbol";
        args = { name_path_pattern: symbol, relative_path: relativePath, include_body: detail === "body", include_info: detail === "info", max_answer_chars: 6_000 };
      } else if (action === "references") {
        if (!symbol || !relativePath) throw new Error("semantic_code action=references requires symbol and path.");
        tool = "find_referencing_symbols";
        args = { name_path: symbol, relative_path: relativePath, max_answer_chars: 6_000 };
      } else if (action === "implementations") {
        if (!symbol || !relativePath) throw new Error("semantic_code action=implementations requires symbol and path.");
        tool = "find_implementations";
        args = { name_path: symbol, relative_path: relativePath, include_info: detail === "info", max_answer_chars: 6_000 };
      } else if (action === "declaration") {
        if (!relativePath || !pattern) throw new Error("semantic_code action=declaration requires path and pattern.");
        tool = "find_declaration";
        args = { relative_path: relativePath, regex: pattern, include_body: detail === "body", include_info: detail === "info" };
      } else {
        if (!relativePath) throw new Error("semantic_code action=diagnostics requires path.");
        tool = "get_diagnostics_for_file";
        args = { relative_path: relativePath, max_answer_chars: 6_000 };
      }
      const response = await semantic.call(workspace.root, tool, args);
      logToolCall(config, { tool: "semantic_code", workspaceId, path: relativePath, success: true, durationMs: Math.round(performance.now() - startedAt) });
      return {
        content: [textBlock(response.result)],
        structuredContent: { result: response.result, action, truncated: response.truncated, backendAgeMs: response.backendAgeMs },
      };
    },
  );

  const semanticEditActionSchema = z.enum(["rename", "replace_body", "insert_before", "insert_after", "safe_delete"]);
  server.registerTool(
    "semantic_edit",
    {
      title: "Semantic code edit",
      description:
        "Serena symbol edit: rename, replace_body, insert_before/after or safe_delete. Use show_changes after the final edit.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        action: semanticEditActionSchema,
        path: z.string().describe("Workspace-relative source file containing the target symbol."),
        symbol: z.string().describe("Target symbol/name-path."),
        newName: z.string().optional().describe("New symbol name for rename."),
        body: z.string().optional().describe("Replacement or inserted code for replace_body/insert_before/insert_after."),
      },
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, action, path: relativePath, symbol, newName, body }) => {
      const startedAt = performance.now();
      if (!semantic?.available) {
        throw new Error("Semantic code editing is unavailable on this host. Install/configure Serena; the tool remains registered so the MCP schema stays stable across restarts.");
      }
      const workspace = await workspaces.getWorkspace(workspaceId);
      workspaces.resolveReadPath(workspace, relativePath);
      let tool: string;
      let args: Record<string, unknown>;
      if (action === "rename") {
        if (!newName) throw new Error("semantic_edit action=rename requires newName.");
        tool = "rename_symbol";
        args = { name_path: symbol, relative_path: relativePath, new_name: newName };
      } else if (action === "replace_body") {
        if (body === undefined) throw new Error("semantic_edit action=replace_body requires body.");
        tool = "replace_symbol_body";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else if (action === "insert_before") {
        if (body === undefined) throw new Error("semantic_edit action=insert_before requires body.");
        tool = "insert_before_symbol";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else if (action === "insert_after") {
        if (body === undefined) throw new Error("semantic_edit action=insert_after requires body.");
        tool = "insert_after_symbol";
        args = { name_path: symbol, relative_path: relativePath, body };
      } else {
        tool = "safe_delete_symbol";
        args = { name_path_pattern: symbol, relative_path: relativePath };
      }
      const response = await semantic.call(workspace.root, tool, args);
      logToolCall(config, { tool: "semantic_edit", workspaceId, path: relativePath, success: true, durationMs: Math.round(performance.now() - startedAt) });
      return {
        content: [textBlock(response.result)],
        structuredContent: { result: response.result, action, truncated: response.truncated, backendAgeMs: response.backendAgeMs },
      };
    },
  );
}

function recommendedPollMs(snapshot: Pick<ProcessSnapshot, "running" | "wallTimeMs" | "idleTimeMs">): number {
  if (!snapshot.running) return 0;
  if (snapshot.idleTimeMs >= 120_000) return 60_000;
  if (snapshot.wallTimeMs < 30_000) return 5_000;
  if (snapshot.wallTimeMs < 120_000) return 15_000;
  if (snapshot.wallTimeMs < 600_000) return 30_000;
  return 60_000;
}

function processResult(snapshot: ProcessSnapshot): string {
  const isError = Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
  const nextPollMs = recommendedPollMs(snapshot);
  const lines = snapshot.running
    ? [snapshot.taskId
      ? `task=${snapshot.taskId} working poll=${nextPollMs}ms fallback="devspace-task wait ${snapshot.taskId}"`
      : `session=${snapshot.sessionId ?? "?"} working poll=${nextPollMs}ms`]
    : [snapshot.signal
      ? `run=${snapshot.runId} signal=${snapshot.signal}`
      : `run=${snapshot.runId} exit=${snapshot.exitCode ?? "unknown"}`];
  const preview = compactPreview(snapshot.output, isError, snapshot.command);
  if (preview) lines.push(preview);
  if (snapshot.logError) {
    lines.push(`log=unavailable; warning=full local log persistence failed: ${snapshot.logError}`);
  } else {
    lines.push(`log=${snapshot.runId}`);
  }
  return lines.join("\n");
}

function processIsError(snapshot: ProcessSnapshot): boolean {
  return Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
}

function processToolResponse(snapshot: ProcessSnapshot, task?: DurableTaskView) {
  const result = processResult(snapshot);
  const isTask = Boolean(snapshot.taskId && snapshot.running);
  const content = [textBlock(result)];
  const terminal = !snapshot.running;
  return {
    content,
    isError: processIsError(snapshot),
    structuredContent: {
      result,
      ...(snapshot.sessionId !== undefined ? { sessionId: snapshot.sessionId } : {}),
      ...(isTask ? {
        taskId: snapshot.taskId,
        pollIntervalMs: task?.pollIntervalMs,
      } : {}),
      runId: snapshot.runId,
      running: snapshot.running,
      wallTimeMs: snapshot.wallTimeMs,
      outputBytes: snapshot.outputBytes,
      outputLines: snapshot.outputLines,
      outputTruncated: snapshot.outputTruncated,
      ...(terminal && snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
      ...(terminal && snapshot.signal ? { signal: snapshot.signal } : {}),
      ...(snapshot.running && !isTask ? { nextPollMs: recommendedPollMs(snapshot) } : {}),
      ...(snapshot.outputTruncated ? { outputTruncated: true } : {}),
      ...(snapshot.logError ? { logError: snapshot.logError } : {}),
    },
  };
}

function taskViewResponse(view: DurableTaskView, options: { detail?: boolean; unchanged?: boolean } = {}) {
  if (options.unchanged) {
    const result = `task=${view.taskId} unchanged rev=${view.revision} poll=${view.pollIntervalMs ?? 0}ms`;
    return {
      content: [textBlock(result)],
      structuredContent: {
        result,
        taskId: view.taskId,
        status: view.status,
        revision: view.revision,
        ...(view.pollIntervalMs ? { pollIntervalMs: view.pollIntervalMs } : {}),
        unchanged: true,
      },
    };
  }
  const state = view.status === "completed"
    ? `completed${view.result?.isError ? " error" : ""}`
    : view.status;
  const terminalExit = view.result?.exitCode;
  const result = `task=${view.taskId} ${state} rev=${view.revision}`
    + (view.pollIntervalMs ? ` poll=${view.pollIntervalMs}ms` : "")
    + (terminalExit !== null && terminalExit !== undefined ? ` exit=${terminalExit}` : "")
    + ` log=${view.runId}`;
  return {
    content: [textBlock(result)],
    isError: view.status === "failed",
    structuredContent: {
      result,
      taskId: view.taskId,
      status: view.status,
      revision: view.revision,
      runId: view.runId,
      ...(view.pollIntervalMs ? { pollIntervalMs: view.pollIntervalMs } : {}),
      ...(view.status === "input_required" && view.inputRequests ? { inputRequests: view.inputRequests } : {}),
      ...(view.result ? {
        isError: view.result.isError,
        exitCode: view.result.exitCode,
        ...(view.result.signal ? { signal: view.result.signal } : {}),
      } : {}),
      ...(view.error ? { error: { code: view.error.code, message: view.error.message } } : {}),
      ...(options.detail ? { detail: view } : {}),
    },
  };
}

function runLogToolResponse(command: string, result: string) {
  const runId = command.trim().split(/\s+/)[2] ?? "run_unknown";
  return {
    content: [textBlock(result)],
    structuredContent: {
      result,
      runId,
      running: false,
      wallTimeMs: 0,
      outputBytes: Buffer.byteLength(result, "utf8"),
      outputLines: result === "" ? 0 : result.split(/\r?\n/).length,
      outputTruncated: false,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;
  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        patch: z.string().describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
      },
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch }) => {
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          assertPatchDoesNotMutateArchitectureState(patch);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];
      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files,
        },
      };
    },
  );
}

function assertPatchDoesNotMutateArchitectureState(patch: string): void {
  const protectedPrefix = ".devspace/architecture";
  const protectedIntent = ".devspace-architecture.json";
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim();
    const prefixes = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    const candidate = line.slice(prefix.length).replace(/^\.\//, "");
    if (candidate === protectedIntent || candidate === protectedPrefix || candidate.startsWith(`${protectedPrefix}/`)) {
      throw new Error("Architecture state is protected. Use the project architecture actions; design changes require an explicit architecture change with rationale.");
    }
  }
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, durableTasks } = context;
  const deliveredTaskRevisions = new Map<string, string>();

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description: "Run commands. Durable tasks: task_wait or devspace-task wait/final/get <taskId> on six-tool clients. final checks the last dependency; no replay. Interactive sessions: write_stdin.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory }, extra) => {
      const workspace = await workspaces.getWorkspace(workspaceId);
      const taskCompat = await handleTaskCompatCommand(
        cmd,
        workspace.root,
        durableTasks,
      );
      if (taskCompat) return taskCompat;
      const runLogResult = await handleRunLogCommand(cmd);
      if (runLogResult !== null) return runLogToolResponse(cmd, runLogResult);
      const projectCompat = await handleProjectCompatCommand(cmd, workspace.root, config.stateDir);
      if (projectCompat) return projectCompat;

      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
          if (!tty && durableTasks?.available) {
            const nodeRequestId = typeof extra?._meta?.["devspace/nodeRequestId"] === "string"
              ? extra._meta["devspace/nodeRequestId"] as string
              : undefined;
            return durableTasks.start({
              workspaceId,
              command: cmd,
              cwd,
              workspaceRoot: workspace.root,
              requestId: nodeRequestId,
              tty: false,
            }, execYieldMs(cmd));
          }
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs: execYieldMs(cmd),
          });
        },
      );
      if (snapshot.taskId && durableTasks?.available) {
        const task = await durableTasks.get(workspace.root, snapshot.taskId, {
          acknowledge: !snapshot.running,
        });
        return processToolResponse(snapshot, task);
      }
      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "task_get",
    {
      title: "Get durable task",
      description: "Read task state. Honor pollIntervalMs.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
        detail: z.boolean().optional().describe("Return full task metadata instead of the compact receipt."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, taskId, detail }, extra) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      const view = await durableTasks.get(workspace.root, taskId);
      const conversationScopeId = conversationScopeIdFromRequestMeta(extra._meta);
      const receiptKey = conversationScopeId ? `${conversationScopeId}\0${workspaceId}\0${taskId}` : undefined;
      const unchanged = !detail && receiptKey !== undefined && deliveredTaskRevisions.get(receiptKey) === view.revision;
      if (receiptKey) {
        deliveredTaskRevisions.delete(receiptKey);
        deliveredTaskRevisions.set(receiptKey, view.revision);
        while (deliveredTaskRevisions.size > 1_000) {
          const oldest = deliveredTaskRevisions.keys().next().value as string | undefined;
          if (!oldest) break;
          deliveredTaskRevisions.delete(oldest);
        }
      }
      return taskViewResponse(view, { detail, unchanged });
    },
  );

  server.registerTool(
    "task_wait",
    {
      title: "Wait for durable task change",
      description: "Bounded read-only task wait (10s max). final=true adds final-dependency diagnostics. No replay.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
        sinceRevision: z.string().optional().describe("Revision from prior task receipt."),
        final: z.boolean().optional().describe("Final dependency status and diagnostics."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, taskId, sinceRevision, final }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      return waitForDurableTask(workspace.root, taskId, durableTasks, sinceRevision, final === true);
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update durable task",
      description:
        "Reserved for MCP task-protocol compatibility. Current durable shell tasks do not support structured input resumption.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
        inputResponses: z.record(z.string(), z.unknown()).describe("Responses keyed by outstanding inputRequest identifiers."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, inputResponses }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.update(workspace.root, taskId, inputResponses);
      const result = `Accepted task input for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { result } };
    },
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel durable task",
      description: "Cancel a durable task.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z.string().describe("Stable task identifier returned by exec_command."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
      const workspace = await workspaces.getWorkspace(workspaceId);
      await durableTasks.cancel(workspace.root, taskId);
      const result = `Cancellation requested for ${taskId}.`;
      return { content: [textBlock(result)], structuredContent: { result } };
    },
  );

  server.registerTool(
    "process_status",
    {
      title: "Check process status",
      description:
        "Check a process session immediately without consuming buffered output. Use only when exec_command returned sessionId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId }) => {
      const startedAt = performance.now();
      const status = await runLoggedToolOperation(
        config,
        { tool: "process_status", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.status(workspaceId, sessionId);
        },
      );
      const nextPollMs = recommendedPollMs(status);
      const state = status.running
        ? "running"
        : status.signal
          ? `signal=${status.signal}`
          : `exit=${status.exitCode ?? "unknown"}`;
      const result = [
        `session=${status.sessionId} ${state} poll=${nextPollMs}ms log=${status.runId}`,
      ];
      if (status.logError) result.push(`warning=full local log persistence failed: ${status.logError}`);
      const resultText = result.join("\n");
      return {
        content: [textBlock(resultText)],
        structuredContent: {
          result: resultText,
          sessionId: status.sessionId,
          runId: status.runId,
          running: status.running,
          wallTimeMs: status.wallTimeMs,
          outputBytes: status.outputBytes,
          outputLines: status.outputLines,
          ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
          ...(status.signal ? { signal: status.signal } : {}),
          ...(status.running ? { nextPollMs } : {}),
          ...(status.logError ? { logError: status.logError } : {}),
        },
      };
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Send input/Ctrl-C, resize, or poll a TTY sessionId from exec_command. Never use sessionId=0 for tasks; use task_get or exec_command 'devspace-task get <taskId>'.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
      },
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows }) => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          const interactionRequested = Boolean(chars?.length) || columns !== undefined || rows !== undefined;
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs: interactionRequested ? CODEX_INTERACTIVE_YIELD_MS : 0,
          });
        },
      );
      return processToolResponse(snapshot);
    },
  );
}

/** Preserve access to existing, owner-scoped project intelligence in ChatGPT
 * clients that cached only six Codex tools. These commands are read-only,
 * exact-prefix checked and do not reach the shell or introduce a second store.
 */
async function handleProjectCompatCommand(command: string, root: string, stateDir: string) {
  const normalized = command.trim();
  if (!/^devspace-project(?:\s|$)/.test(normalized)) return undefined;
  if (normalized.length > 260 || /[\r\n;&|`$\\]/.test(normalized)) {
    throw new Error("Invalid devspace-project compatibility command; use one read-only action without shell syntax.");
  }
  const action = normalized.slice("devspace-project".length).trim();
  const learning = new LearningStore(stateDir);
  let result: string;
  if (!action || action === "help") {
    result = "Read-only six-tool project commands: devspace-project learn-suggest | learn-recall QUERY | learn-stats | arch-validate. Use the project tool for explicit architecture changes or verified learning promotion when available.";
  } else if (action === "learn-suggest") {
    const suggestions = learning.suggestVerifiedProcedures(root, 5);
    result = suggestions.length ? suggestions.map((entry) => (
      `${entry.occurrences} passed checks: ${entry.command} (latest ${entry.lastVerifiedAt}; episodes ${entry.evidenceEpisodeIds.join(",")})`
    )).join("\n") : "No recent repeated verified checks. No skill was created or promoted.";
  } else if (action === "learn-stats") {
    const stats = learning.stats(root);
    result = `Learning: ${stats.episodes} episodes (${stats.successful} successful), ${stats.candidates} candidates, ${stats.promoted} promoted.`;
  } else if (action.startsWith("learn-recall ")) {
    const query = action.slice("learn-recall ".length).trim();
    if (!query || query.length > 140) throw new Error("learn-recall query must contain 1-140 characters.");
    const recalled = learning.recall(root, query, 5);
    const lines = [
      ...recalled.candidates.map((candidate) => `candidate=${candidate.id} status=${candidate.status} title=${candidate.title.slice(0, 100)}`),
      ...recalled.episodes.map((episode) => `episode=${episode.id} ${episode.success ? "ok" : "failed"} tool=${episode.tool} input=${episode.inputSummary.slice(0, 135)} output=${episode.outputSummary.slice(0, 135)}`),
    ];
    result = lines.join("\n") || "No relevant project learning evidence found.";
  } else if (action === "arch-validate") {
    const manager = new ArchitectureModelManager();
    if (!await manager.hasModel(root)) {
      result = "Architecture policy not initialized in this workspace. Use the full project tool for an explicit arch_init, rather than inventing constraints.";
    } else {
      const issues = await manager.conformance(root);
      const errors = issues.filter((issue) => issue.severity === "error").length;
      result = `Architecture validation: ${errors} error(s), ${issues.length - errors} warning(s).`
        + (issues.length ? "\n" + issues.slice(0, 8).map((issue) =>
          `${issue.severity}:${issue.code} ${issue.message.slice(0, 220)}`).join("\n") : "");
    }
  } else {
    throw new Error("Unknown read-only devspace-project action; use devspace-project help.");
  }
  return {
    content: [textBlock(result)],
    structuredContent: { result, projectAction: action.split(" ")[0] || "help", readOnly: true },
  };
}

async function handleTaskCompatCommand(
  command: string,
  workspaceRoot: string,
  durableTasks: ToolRegistrationContext["durableTasks"],
) {
  const match = command.trim().match(/^devspace-task\s+(get|wait|final|cancel)\s+(task_(?:[0-9a-f]{16}|[0-9a-f-]{36}))$/i);
  if (!match) return undefined;
  if (!durableTasks?.available) throw new Error("Durable tasks are unavailable in this build.");
  const action = match[1]!.toLowerCase();
  const taskId = match[2]!;
  if (action === "get") {
    return taskViewResponse(await durableTasks.get(workspaceRoot, taskId));
  }
  if (action === "wait" || action === "final") {
    return waitForDurableTask(workspaceRoot, taskId, durableTasks, undefined, action === "final");
  }
  await durableTasks.cancel(workspaceRoot, taskId);
  const result = `Cancellation requested for ${taskId}.`;
  return {
    content: [textBlock(result)],
    structuredContent: { result, taskId },
  };
}

async function waitForDurableTask(
  workspaceRoot: string,
  taskId: string,
  durableTasks: NonNullable<ToolRegistrationContext["durableTasks"]>,
  sinceRevision?: string,
  final = false,
) {
  let notify: (() => void) | undefined;
  let changedBeforeSubscribe = false;
  // Ownership is validated and the OS watcher is installed before the
  // first read, so an atomic update cannot be lost between the two.
  const closeWatch = await durableTasks.watchChanges(workspaceRoot, taskId, () => {
    changedBeforeSubscribe = true;
    notify?.();
  });
  let waited;
  try {
    waited = await waitForTaskChange(
      () => durableTasks.get(workspaceRoot, taskId, { acknowledge: false }),
      sinceRevision,
      {
        subscribe: (onChange) => {
          notify = onChange;
          if (changedBeforeSubscribe) onChange();
          return () => { notify = undefined; };
        },
      },
    );
  } finally {
    closeWatch();
  }
  if (!waited.unchanged && ["completed", "failed", "cancelled"].includes(waited.view.status)) {
    await durableTasks.get(workspaceRoot, taskId); // acknowledge terminal notification
  }
  return final ? finalWaitResponse(waited, taskId)
    : taskViewResponse(waited.view, { unchanged: waited.unchanged });
}

async function finalWaitResponse(waited: TaskWaitResult, taskId: string) {
  const response = taskViewResponse(waited.view, { unchanged: waited.unchanged });
  const barrier = finalBarrierReceipt(waited.view);
  // A final wait remains bounded; inspect read-only log metadata after 60s.
  let evidence: Record<string, unknown> | undefined;
  if (barrier.stage === "investigate") {
    try {
      const raw = await handleRunLogCommand(`devspace-log meta ${barrier.runId}`);
      const info = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
      if (info) {
        evidence = {
          available: true,
          ...(typeof info.status === "string" ? { status: info.status } : {}),
          ...(typeof info.running === "boolean" ? { running: info.running } : {}),
          ...(typeof info.stale === "boolean" ? { stale: info.stale } : {}),
          ...(typeof info.lastActivityAt === "string" ? { lastActivityAt: info.lastActivityAt } : {}),
          ...(typeof info.outputBytes === "number" ? { outputBytes: info.outputBytes } : {}),
          ...(typeof info.outputLines === "number" ? { outputLines: info.outputLines } : {}),
        };
      }
    } catch {
      evidence = { available: false };
    }
  }
  const hint = barrier.stage === "investigate"
    ? `Final dependency ${taskId} still running for ${Math.ceil(barrier.elapsedMs / 1000)}s; inspect devspace-log tail/grep ${barrier.runId}, validate task/peer health and checkpoint unresolved work. Never repeat the command automatically.`
    : barrier.stage === "waiting"
      ? `Final dependency pending; next suggested check after ~${barrier.nextCheckMs}ms, or continue independent work.`
      : barrier.stage === "input_required"
        ? `Final dependency ${taskId} requests input; inspect the request or cancel instead of polling.`
        : `Final dependency is ${waited.view.status}; verify logs and objective before completion.`;
  return {
    ...response,
    content: [...response.content, textBlock(hint)],
    structuredContent: { ...response.structuredContent, finalBarrier: {
      ...barrier, ...(evidence ? { diagnostic: evidence } : {}),
    } },
  };
}
