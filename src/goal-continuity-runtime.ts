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
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:test|typecheck|lint|check|run\s+(?:test|typecheck|lint|check))|pnpm\s+exec\s+tsx\s+--test|(?:node|tsx)\s+--test|pytest|cargo\s+(?:test|check)|go\s+test|make\s+test)(?:\s|$)/i.test(trimmed);
}

/** Only annotate explicitly selected workflows, never the newest workflow in a directory. */
export function withWorkflowReceipt<T extends ToolReceipt>(
  input: {
    stateDir: string;
    workspaceRoot: string;
    workspaceId: string;
    conversationScope?: string;
    workflowId?: string;
    observation?: {
      eventKey: string;
      kind: WorkflowExecutionEvidence["kind"];
      status: WorkflowExecutionEvidence["status"];
      runId?: string;
      taskId?: string;
      exitCode?: number;
    };
  },
  response: T,
): T {
  if (!input.workflowId && !input.conversationScope) return response;
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
  const hint = continuityHint(record.workflow, record.goal);
  return {
    ...response,
    content: [...response.content, { type: "text", text: hint }],
    structuredContent: {
      ...response.structuredContent,
      operation: input.observation ? {
        status: input.observation.status,
        ...(input.observation.exitCode !== undefined ? { exitCode: input.observation.exitCode } : {}),
      } : undefined,
      continuity: { workflowId: record.workflow.workflowId, ...record.goal },
      ...(record.observation ? { evidenceRef: record.observation.eventId } : {}),
    },
  } as T;
}
