import { createHash } from "node:crypto";
import type { ToolMode } from "./config.js";

const TOOL_NAMES: Record<ToolMode, readonly string[]> = {
  claude: [
    "open_workspace",
    "read",
    "project",
    "write",
    "edit",
    "bash",
    "show_changes",
    "workflow_open",
    "workflow_status",
    "workflow_checkpoint",
  ],
  codex: [
    "open_workspace",
    "read",
    "project",
    "apply_patch",
    "exec_command",
    "task_get",
    "task_wait",
    "task_update",
    "task_cancel",
    "process_status",
    "write_stdin",
    "semantic_code",
    "semantic_edit",
    "show_changes",
    "workflow_open",
    "workflow_status",
    "workflow_checkpoint",
  ],
};

export function expectedToolNames(mode: ToolMode): string[] {
  return [...TOOL_NAMES[mode]].sort();
}

export function toolSchemaFingerprint(tools: unknown[]): string {
  const normalized = [...tools]
    .map((tool) => normalizeTool(tool))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 20);
}

function normalizeTool(value: unknown): { name: string } & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: String(value) };
  }
  const tool = value as Record<string, unknown>;
  return {
    name: typeof tool.name === "string" ? tool.name : "",
    title: tool.title,
    description: tool.description,
    inputSchema: normalizeSchema(tool.inputSchema),
    outputSchema: normalizeSchema(tool.outputSchema),
    annotations: normalizeSchema(tool.annotations),
  };
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "$schema")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeSchema(nested)]),
  );
}
