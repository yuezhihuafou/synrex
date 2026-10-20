import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { CodingWorkflowStore, type CodingWorkflowCheckpoint } from "./coding-workflows.js";
import { assertAllowedPath } from "./roots.js";
import { expandHomePath } from "./roots.js";

const items = z.array(z.string().trim().min(1).max(2000)).max(40);
const createInput = z.strictObject({
  title: z.string().trim().min(1).max(4000),
  goal: z.string().trim().min(1).max(4000),
  acceptanceCriteria: items.min(1),
  constraints: items,
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
});
const checkpointInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  status: z.enum(["active", "blocked", "completed", "cancelled"]),
  checkpoint: z.strictObject({
    phase: z.string().trim().min(1).max(4000),
    summary: z.string().trim().min(1).max(4000),
    completedSteps: items,
    nextSteps: items,
    blockers: items,
    checks: items,
    taskIds: z.array(z.string().regex(/^task_[a-zA-Z0-9-]+$/)).max(40),
    gitHead: z.string().optional(),
    gitStatus: z.string().optional(),
  }),
});
const workflowIdPattern = /^wf_[a-f0-9]{24}$/;

export async function runWorkflowCommand(
  args: string[],
  config: Pick<ServerConfig, "stateDir" | "allowedRoots">,
  options: { cwd?: string; readInput?: () => Promise<string>; write?: (line: string) => void } = {},
): Promise<void> {
  const [action, ...rest] = args;
  const index = rest.indexOf("--workspace");
  if (index >= 0 && (!rest[index + 1] || rest[index + 1]?.startsWith("--"))) {
    throw new Error("--workspace requires an existing path");
  }
  const workspaceArg = index >= 0 ? rest.splice(index, 2)[1]! : options.cwd ?? process.cwd();
  // Resolve symlinks before checking authority and before looking up workspace identity.
  const workspace = realpathSync(resolve(expandHomePath(workspaceArg)));
  assertAllowedPath(workspace, config.allowedRoots.map((root) => {
    const absolute = resolve(expandHomePath(root));
    try { return realpathSync(absolute); } catch { return absolute; }
  }));
  const write = options.write ?? console.log;
  const store = new CodingWorkflowStore(config.stateDir);
  try {
    if (action === "list" && rest.length === 0) {
      write(JSON.stringify({ workflows: store.list(workspace, { limit: 15 }) }));
      return;
    }
    if (action === "show" && rest.length === 1 && workflowIdPattern.test(rest[0]!)) {
      write(JSON.stringify({
        workflow: store.getRequired(rest[0]!, workspace),
        history: store.history(rest[0]!, workspace),
      }));
      return;
    }
    if (action === "create" && rest.length === 0) {
      const payload = createInput.parse(JSON.parse(await (options.readInput ?? readStdin)()));
      write(JSON.stringify(store.create(workspace, payload)));
      return;
    }
    if (action === "checkpoint" && rest.length === 1 && workflowIdPattern.test(rest[0]!)) {
      const payload = checkpointInput.parse(JSON.parse(await (options.readInput ?? readStdin)()));
      if (payload.status === "completed" && (
        payload.checkpoint.nextSteps.length > 0 || payload.checkpoint.blockers.length > 0
        || payload.checkpoint.taskIds.length > 0
      )) throw new Error("Cannot complete a workflow with unfinished work or tasks");
      // Never trust a shell-supplied Git snapshot; only MCP's managed checkpoint
      // endpoint captures one. The CLI persists explicit, inspectable evidence.
      const checkpoint: CodingWorkflowCheckpoint = {
        ...payload.checkpoint,
        gitHead: undefined,
        gitStatus: undefined,
      };
      write(JSON.stringify(store.checkpoint(workspace, {
        workflowId: rest[0]!, expectedRevision: payload.expectedRevision,
        status: payload.status, checkpoint,
      })));
      return;
    }
    throw new Error("Usage: devspace workflow list|show <wf_id>|create|checkpoint <wf_id> [--workspace <path>]; create/checkpoint accept JSON on stdin");
  } finally {
    store.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Provide JSON on stdin; interactive input is not supported");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 64_000) throw new Error("Workflow input too large");
  }
  if (!text.trim()) throw new Error("Workflow JSON stdin is empty");
  return text;
}
