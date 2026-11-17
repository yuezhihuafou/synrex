import { withCodingWorkflowStore, type WorkflowExecutionEvidence } from "./coding-workflows.js";
import { assessGoal, continuityHint } from "./goal-continuity.js";

type ToolReceipt = {
  content: unknown[];
  structuredContent: Record<string, unknown>;
};

/** A pure test command can prove it exited successfully; arbitrary shell success cannot. */
export function verificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/[;&|\x60\n\r]/.test(trimmed) || /\$\(/.test(trimmed)) return false;
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:test|typecheck|lint|check|build|run\s+(?:test|typecheck|lint|check|build))|pnpm\s+exec\s+(?:tsx\s+--test|tsc)|(?:node|tsx)\s+--test|pytest|cargo\s+(?:test|check|build)|go\s+test|make\s+(?:test|build))(?:\s|$)/i.test(trimmed);
}

/** Path-qualified checks can be invalidated independently of unrelated code.
 * Unqualified checks cover the normal code/dependency scope conservatively.
 */
export function verificationScope(command: string, workingDirectory = "."): string[] {
  const paths = command.match(/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?|[\w./-]+\.py/g) ?? [];
  if (!paths.length || paths.length > 12) return [];
  const directory = workingDirectory.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (directory.startsWith("/") || directory.split("/").includes("..")) return [];
  const scope = new Set(["package.json", "pnpm-lock.yaml", "tsconfig.json"]);
  if (directory && directory !== ".") scope.add(`${directory}/package.json`);
  for (const file of paths) {
    if (file.startsWith("/") || file.split("/").includes("..")) return [];
    const qualified = directory && directory !== "." ? `${directory}/${file}` : file;
    scope.add(qualified);
    scope.add(qualified.replace(/\.(test|spec)\./, "."));
  }
  return [...scope];
}

/** Only annotate explicitly selected workflows, never the newest workflow in a directory. */
export function withWorkflowReceipt<T extends ToolReceipt>(
  input: {
    stateDir: string;
    workspaceRoot: string;
    workspaceId: string;
    conversationScope?: string;
    workflowId?: string;
    enabled?: boolean;
    observation?: {
      eventKey: string;
      kind: WorkflowExecutionEvidence["kind"];
      status: WorkflowExecutionEvidence["status"];
      runId?: string;
      taskId?: string;
      sessionId?: number;
      exitCode?: number;
      command?: string;
      workingDirectory?: string;
      workspaceId?: string;
      nodeAlias?: string;
      source?: WorkflowExecutionEvidence["source"];
      verificationScope?: string[];
    };
  },
  response: T,
): T {
  if (input.enabled === false || (!input.workflowId && !input.conversationScope)) return response;
  try {
  const record = withCodingWorkflowStore(input.stateDir, (store) => {
    const workflow = store.selected(
      input.workspaceRoot, input.workspaceId, input.conversationScope, input.workflowId,
    );
    if (!workflow || workflow.status === "completed" || workflow.status === "cancelled") return undefined;
    const observation = input.observation
      ? store.observe(input.workspaceRoot, workflow.workflowId, input.observation)
      : undefined;
    const goal = assessGoal(workflow, store.evidence(workflow.workflowId, input.workspaceRoot));
    return { workflow, goal, observation };
  });
  if (!record) return response;
  const noteworthy = input.observation && (["failed", "cancelled", "unknown", "input_required"].includes(input.observation.status)
    || input.observation.kind === "verification" && input.observation.status === "completed");
  const hint = `Operation: ${input.observation?.status ?? "observed"}; Goal: ${record.goal.status}; `
    + `Remaining: ${record.goal.remaining[0]?.slice(0, 90) ?? "none"}; `
    + `Next: ${record.workflow.checkpoint.nextSteps[0]?.slice(0, 90) ?? record.goal.nextAction}`;
  return {
    ...response,
    content: noteworthy ? [...response.content, { type: "text", text: hint }] : response.content,
    structuredContent: {
      ...response.structuredContent,
      ...(noteworthy && input.observation ? { operation: {
        status: input.observation.status,
        ...(input.observation.exitCode !== undefined ? { exitCode: input.observation.exitCode } : {}),
      } } : {}),
      ...(noteworthy ? { continuity: {
        workflowId: record.workflow.workflowId,
        status: record.goal.status,
        remainingCount: record.goal.remaining.length,
        pendingCount: record.goal.pendingOperations.length,
        nextAction: record.goal.nextAction,
      } } : {}),
      ...(record.observation ? { evidenceRef: record.observation.eventId } : {}),
    },
  } as T;
  } catch (error) {
    // The primary operation already took effect. Never transform its success
    // into an MCP failure or cause a caller to blindly replay a write.
    const message = error instanceof Error ? error.message : String(error);
    return { ...response, structuredContent: {
      ...response.structuredContent,
      continuityWarning: "Non-blocking continuity record failed: " + message.slice(0, 240),
    } } as T;
  }
}
