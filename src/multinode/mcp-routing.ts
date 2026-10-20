import { randomBytes } from "node:crypto";
import { waitForTaskChange } from "../durable-task-wait.js";
import type { DurableTaskView } from "../durable-task-model.js";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import type { MultiNodeRouter } from "./router.js";
import { selectWorkspaceNode, type WorkspacePlacementRule } from "./placement.js";
import type { ControlPlaneStore } from "./store.js";

type ToolHandler = (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown;

export function withMultiNodeRouting(
  target: McpRegistrationTarget,
  options: {
    router: MultiNodeRouter;
    store: ControlPlaneStore;
    localNodeId: string;
    placementRules?: readonly WorkspacePlacementRule[];
  },
): McpRegistrationTarget {
  return {
    registerTool: ((
      name: string,
      definition: unknown,
      handler: ToolHandler,
    ) => (target.registerTool as (...args: unknown[]) => unknown)(
      name,
      definition,
      async (input: Record<string, unknown>, extra: Record<string, unknown>) => {
        if (name === "open_workspace") {
          const selector = typeof input.node === "string" ? input.node : undefined;
          const path = typeof input.path === "string" ? input.path : "";
          const placement = selectWorkspaceNode(options.store, {
            selector,
            path,
            localNodeId: options.localNodeId,
            rules: options.placementRules,
          });
          const selected = placement.node;
          if (selected.id !== options.localNodeId) {
            const { node: _node, ...arguments_ } = input;
            const result = await options.router.openWorkspace({
              node: selector,
              arguments: arguments_,
              meta: asMeta(extra._meta),
            });
            return decorateNodeResult(result, selected, options.store);
          }
          const result = await Promise.resolve(handler(input, extra)) as Record<string, unknown>;
          const workspaceId = structuredString(result, "workspaceId");
          if (workspaceId) {
            options.store.bindWorkspace({
              workspaceId,
              nodeId: options.localNodeId,
              localWorkspaceId: workspaceId,
            });
          }
          return decorateNodeResult(result, selected, options.store);
        }

        const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : undefined;
        if (!workspaceId) return handler(input, extra);
        const route = options.store.resolveWorkspace(workspaceId);
        if (!route || route.nodeId === options.localNodeId) {
          // A coordinator migration can preserve a global ID that differs
          // from the original local session ID. Keep both identities stable.
          const localWorkspaceId = route?.localWorkspaceId ?? workspaceId;
          const embeddedTaskId = compatTaskId(name, input);
          const requestedTaskId = typeof input.taskId === "string" ? input.taskId : embeddedTaskId;
          const taskRoute = requestedTaskId ? options.store.resolveTask(requestedTaskId) : undefined;
          if (taskRoute && (taskRoute.nodeId !== options.localNodeId || taskRoute.workspaceId !== workspaceId)) {
            throw new Error(`Task ${requestedTaskId} does not belong to workspace ${workspaceId}.`);
          }
          const localInput: Record<string, unknown> = { ...input, workspaceId: localWorkspaceId };
          if (taskRoute) {
            if (typeof input.taskId === "string") localInput.taskId = taskRoute.localTaskId;
            else if (embeddedTaskId) localInput.cmd = rewriteCompatTaskCommand(String(input.cmd), embeddedTaskId, taskRoute.localTaskId);
          }
          let result = await Promise.resolve(handler(localInput, extra)) as Record<string, unknown>;
          result = rewriteOpaqueId(result, localWorkspaceId, workspaceId);
          if (taskRoute) return rewriteOpaqueId(result, taskRoute.localTaskId, taskRoute.taskId);
          bindTaskIfPresent(options.store, options.localNodeId, workspaceId, result);
          return result;
        }
        const embeddedTaskId = compatTaskId(name, input);
        const requestedTaskId = typeof input.taskId === "string"
          ? input.taskId
          : embeddedTaskId;
        const taskRoute = requestedTaskId
          ? options.store.resolveTask(requestedTaskId)
          : undefined;
        if (taskRoute && (taskRoute.nodeId !== route.nodeId || taskRoute.workspaceId !== workspaceId)) {
          throw new Error(`Task ${input.taskId} does not belong to workspace ${workspaceId}.`);
        }
        const remoteArguments = taskRoute
          ? typeof input.taskId === "string"
            ? { ...input, taskId: taskRoute.localTaskId }
            : embeddedTaskId
              ? {
                  ...input,
                  cmd: rewriteCompatTaskCommand(
                    String(input.cmd),
                    embeddedTaskId,
                    taskRoute.localTaskId,
                  ),
                }
              : input
          : input;
        // A newer swy1 coordinator may serve an older gateway peer. Only
        // downgrade when the peer explicitly advertises task_get v1 but has
        // not advertised task_wait at all. Never retry/restart the command,
        // and never mask an explicitly incompatible task_wait contract.
        const peer = options.store.getNode(route.nodeId);
        const contracts = peer?.capabilities.toolContracts;
        if (name === "exec_command" && isCompatTaskWait(name, input)) {
          // Keep legacy six-tool clients on the safe read-only wait path.
          // An older peer must never try to execute an unrecognised
          // devspace-task wait command through its shell.
          if (!taskRoute || typeof remoteArguments.cmd !== "string") {
            throw new Error(`Cannot wait for task ${requestedTaskId ?? "unknown"}: no verified remote task owner.`);
          }
          if (contracts?.task_wait === 1) {
            const response = await options.router.callWorkspaceTool({
              workspaceId,
              name: "task_wait",
              arguments: { workspaceId, taskId: taskRoute.localTaskId },
              meta: asMeta(extra._meta),
            });
            return rewriteOpaqueId(response, taskRoute.localTaskId, taskRoute.taskId);
          }
          if (contracts?.task_get !== 1 || (contracts.task_wait !== undefined && contracts.task_wait !== 1)) {
            throw new Error(`Remote peer has no compatible read-only wait contract for ${requestedTaskId}.`);
          }
          const response = await legacyRemoteTaskWait(
            options.router, workspaceId, taskRoute.localTaskId, asMeta(extra._meta),
          );
          return rewriteOpaqueId(response, taskRoute.localTaskId, taskRoute.taskId);
        }
        if (name === "task_wait" && contracts && contracts.task_wait === undefined
          && contracts.task_get === 1 && typeof remoteArguments.taskId === "string") {
          const response = await legacyRemoteTaskWait(
            options.router, workspaceId, remoteArguments.taskId, asMeta(extra._meta),
            typeof input.sinceRevision === "string" ? input.sinceRevision : undefined,
          );
          return taskRoute
            ? rewriteOpaqueId(response, taskRoute.localTaskId, taskRoute.taskId)
            : response;
        }
        const result = await options.router.callWorkspaceTool({
          workspaceId,
          name,
          arguments: remoteArguments,
          meta: asMeta(extra._meta),
        });
        if (taskRoute) {
          return rewriteOpaqueId(result, taskRoute.localTaskId, taskRoute.taskId);
        }
        return bindRemoteTaskIfPresent(options.store, route.nodeId, workspaceId, result);
      },
    )) as McpRegistrationTarget["registerTool"],
    registerResource: target.registerResource.bind(target),
  };
}

function compatTaskId(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== "exec_command" || typeof input.cmd !== "string") return undefined;
  const match = input.cmd.trim().match(
    /^devspace-task\s+(?:get|wait|cancel)\s+(task_(?:[0-9a-f]{16}|[0-9a-f]{32}|[0-9a-f-]{36}))$/i,
  );
  return match?.[1];
}

function isCompatTaskWait(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "exec_command" && Boolean(compatTaskId(toolName, input))
    && /^devspace-task\s+wait\s+/i.test(String(input.cmd).trim());
}

async function legacyRemoteTaskWait(
  router: MultiNodeRouter,
  workspaceId: string,
  taskId: string,
  meta: Record<string, unknown> | undefined,
  sinceRevision?: string,
): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> | undefined;
  const waited = await waitForTaskChange(async () => {
    latest = await router.callWorkspaceTool({
      workspaceId, name: "task_get",
      arguments: { workspaceId, taskId, detail: true },
      meta,
    });
    const state = latest.structuredContent;
    const fields = state && typeof state === "object" && !Array.isArray(state)
      ? state as Record<string, unknown> : undefined;
    if (!fields || fields.taskId !== taskId
      || !["working", "completed", "failed", "cancelled", "input_required"].includes(String(fields.status))) {
      throw new Error("Legacy peer task_get returned an invalid or mismatched task receipt.");
    }
    return state as DurableTaskView;
  }, sinceRevision, { waitMs: 8_000, pollMs: 1_000 });
  return compactLegacyTaskWaitReceipt(latest!, waited.unchanged);
}

function rewriteCompatTaskCommand(
  command: string,
  fromTaskId: string,
  toTaskId: string,
): string {
  return command.replace(fromTaskId, toTaskId);
}

function compactLegacyTaskWaitReceipt(
  response: Record<string, unknown>,
  unchanged: boolean,
): Record<string, unknown> {
  const source = response.structuredContent as Record<string, unknown>;
  const taskId = source.taskId as string;
  const status = source.status as string;
  const revision = typeof source.revision === "string" ? source.revision : undefined;
  const exitCode = typeof source.exitCode === "number" ? source.exitCode : undefined;
  const result = `task=${taskId} ${unchanged ? "unchanged" : status}`
    + (revision ? ` rev=${revision}` : "")
    + (exitCode !== undefined ? ` exit=${exitCode}` : "");
  const structuredContent: Record<string, unknown> = {
    result, taskId, status,
    ...(revision ? { revision } : {}),
    ...(typeof source.runId === "string" ? { runId: source.runId } : {}),
    ...(typeof source.pollIntervalMs === "number" ? { pollIntervalMs: source.pollIntervalMs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(source.isError === true ? { isError: true } : {}),
    ...(status === "input_required" && Array.isArray(source.inputRequests)
      ? { inputRequests: source.inputRequests } : {}),
    ...(source.error && typeof source.error === "object" && !Array.isArray(source.error)
      ? { error: {
          code: (source.error as Record<string, unknown>).code,
          message: String((source.error as Record<string, unknown>).message ?? "").slice(0, 240),
        } } : {}),
    ...(unchanged ? { unchanged: true } : {}),
  };
  return {
    content: [{ type: "text", text: result }],
    isError: response.isError === true,
    structuredContent,
  };
}

function bindTaskIfPresent(
  store: ControlPlaneStore,
  nodeId: string,
  workspaceId: string,
  result: Record<string, unknown>,
): void {
  const taskId = structuredString(result, "taskId");
  if (!taskId) return;
  const runId = structuredString(result, "runId");
  store.bindTask({ taskId, nodeId, workspaceId, localTaskId: taskId, runId });
}

function bindRemoteTaskIfPresent(
  store: ControlPlaneStore,
  nodeId: string,
  workspaceId: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const localTaskId = structuredString(result, "taskId");
  if (!localTaskId) return result;
  const existing = store.findTaskByLocal(nodeId, localTaskId);
  const taskId = existing?.taskId ?? createGlobalTaskId();
  const runId = structuredString(result, "runId");
  if (!existing) {
    store.bindTask({ taskId, nodeId, workspaceId, localTaskId, runId });
  }
  return rewriteOpaqueId(result, localTaskId, taskId);
}

function createGlobalTaskId(): string {
  return `task_${randomBytes(16).toString("hex")}`;
}

function decorateNodeResult(
  result: Record<string, unknown>,
  node: { id: string; alias?: string; health: string },
  store: ControlPlaneStore,
): Record<string, unknown> {
  const availableNodes = store.listNodes();
  const availableSummary = availableNodes
    .map((candidate) => `${candidate.alias ?? candidate.id}=${candidate.health}`)
    .join(", ");
  const content = Array.isArray(result.content)
    ? [
        ...result.content,
        {
          type: "text",
          text: `Execution node: ${node.alias ?? node.id} (${node.health}).${availableSummary ? ` Available nodes: ${availableSummary}.` : ""}`,
        },
      ]
    : result.content;
  return { ...result, content };
}

function structuredString(result: Record<string, unknown>, key: string): string | undefined {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const value = (structured as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function asMeta(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rewriteOpaqueId<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.replaceAll(from, to) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteOpaqueId(item, from, to)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, rewriteOpaqueId(nested, from, to)]),
  ) as T;
}
