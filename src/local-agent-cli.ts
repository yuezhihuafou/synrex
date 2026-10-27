import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { AgentProviderExecutionError, captureAgentProviderResult } from "./local-agent-errors.js";
import type {
  LocalAgentDriver, LocalAgentRunCallbacks, LocalAgentRunInput,
  LocalAgentRunResult, LocalAgentRuntime, LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { prepareAntigravityExecution } from "./local-agent-antigravity-sandbox.js";

/** Declarative headless CLI contract. No provider-specific execution loop. */
export interface CliAgentSpec {
  command: string;
  args?: string[];
  defaultModel?: string;
  outputFormat?: "json" | "stream-json";
  promptFlag?: string;
  modelFlag?: string;
  effortFlag?: string;
  sessionFlag?: string;
  statusField?: string;
  successStatus?: string;
  responseField?: string;
  sessionField?: string;
  errorField?: string;
  deniedActionsField?: string;
  usageField?: string;
  isolation?: "none" | "antigravity";
  timeoutMs?: number;
}

export interface CliAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

const MAX_OUTPUT_BYTES = 2_000_000;
const MAX_STDERR_BYTES = 16_384;
const MAX_PROGRESS_EVENTS = 200;

export class GenericCliAgentDriver implements LocalAgentDriver {
  readonly provider: string;
  readonly idleTimeoutMs = 60_000;

  constructor(
    provider: string,
    private readonly spec: CliAgentSpec,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly stateDir?: string,
  ) {
    this.provider = provider;
  }

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    return "cli:" + this.provider + ":" + this.spec.command +
      (this.spec.isolation === "antigravity" ? ":" + _context.agentId : "");
  }

  async createRuntime(context?: LocalAgentRuntimeContext) {
    if (this.spec.isolation === "antigravity" && this.stateDir && context?.agentId && !/^agt_[a-zA-Z0-9]+$/.test(context.agentId)) {
      throw new Error("Invalid private CLI agent identifier.");
    }
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const children = new Set<ChildProcess>();
        let alive = true;
        return {
          provider: this.provider,
          isAlive: () => alive,
          releaseSession: async () => {},
          close: async () => {
            alive = false;
            for (const child of children) child.kill("SIGTERM");
          },
          run: (input, callbacks) => captureAgentProviderResult({
            provider: this.provider,
            operation: "run",
            run: async (): Promise<LocalAgentRunResult> => {
              if (!alive) throw new Error("CLI runtime is closed.");
              return executeCliAgent(this.provider, this.spec, this.env, input, callbacks, children,
                this.spec.isolation === "antigravity" && this.stateDir && context?.agentId
                  ? join(this.stateDir, "subagent-cli-sessions", context.agentId) : undefined);
            },
          }),
        };
      },
    });
  }
}

function buildArgs(spec: CliAgentSpec, input: LocalAgentRunInput): string[] {
  const args = [...(spec.args ?? [])];
  const model = input.model ?? spec.defaultModel;
  if (model) {
    if (!spec.modelFlag) throw new Error("CLI provider does not support a model override.");
    args.push(spec.modelFlag, model);
  }
  if (input.effort) {
    if (!spec.effortFlag) throw new Error("CLI provider does not support an effort setting.");
    args.push(spec.effortFlag, input.effort);
  }
  if (input.providerSessionId) {
    if (!spec.sessionFlag) throw new Error("CLI provider cannot resume a previous session.");
    args.push(spec.sessionFlag, input.providerSessionId);
  }
  args.push(spec.promptFlag ?? "--print", input.prompt);
  return args;
}

async function executeCliAgent(
  provider: string, spec: CliAgentSpec, env: NodeJS.ProcessEnv,
  input: LocalAgentRunInput, callbacks: LocalAgentRunCallbacks | undefined,
  children: Set<ChildProcess>,
  sessionStateDir?: string,
): Promise<LocalAgentRunResult> {
  if (spec.isolation !== "antigravity" && input.writeMode === "read_only") {
    throw new Error("Generic CLI read-only execution needs an explicit isolation implementation.");
  }
  const args = buildArgs(spec, input);
  const plan = spec.isolation === "antigravity"
    ? prepareAntigravityExecution({
        workspaceRoot: input.workspaceRoot, providerCommand: spec.command,
        providerArgs: args, writeMode: input.writeMode, env, sessionStateDir,
      })
    : { command: spec.command, args, env, close: () => {} };
  const pending: Promise<void>[] = [];
  let streamedResult: Record<string, unknown> | undefined;
  let progressCount = 0;
  let streamedEvents = false;
  let lastSessionId: string | undefined;
  const queue = (callback: Promise<void> | void | undefined): void => {
    if (callback) pending.push(Promise.resolve(callback));
  };
  const processLine = (line: string): void => {
    let entry: Record<string, unknown> | undefined;
    try { entry = asObject(JSON.parse(line)); } catch { return; }
    if (!entry) return;
    const event = typeof entry.event === "string" ? entry.event : undefined;
    if (event === "result") {
      streamedResult = asObject(entry.result);
    } else if (event) {
      streamedEvents = true;
      if (progressCount++ < MAX_PROGRESS_EVENTS) {
        const detail = asObject(entry[event]);
        const state = typeof detail?.state === "string" ? ":" + detail.state : "";
        queue(callbacks?.onEvent?.({
          label: (event + state).slice(0, 96),
          usage: readUsage(detail?.usage),
        }));
      }
    }
    const detail = asObject(event && entry[event]) ?? entry;
    const id = getText(detail, spec.sessionField ?? "conversation_id");
    if (id && id !== lastSessionId) {
      lastSessionId = id;
      queue(callbacks?.onSessionId?.(id));
    }
  };

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let truncated = false;
  let exitCode: number | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, {
        cwd: input.workspaceRoot, env: plan.env,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      children.add(child);
      let lineBuffer = "";
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
        force.unref();
      }, spec.timeoutMs ?? 190_000);
      const finish = () => { clearTimeout(deadline); children.delete(child); };
      child.stdout?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        const text = chunk.toString("utf8");
        if (spec.outputFormat === "stream-json") {
          // Some older CLI versions emit one pretty-printed final JSON
          // object even when stream-json was requested. Retain only a bounded
          // compatibility window; normal line-by-line events still take
          // precedence and are not replayed.
          if (stdout.length < 64 * 1024) stdout += text.slice(0, 64 * 1024 - stdout.length);
          lineBuffer += text;
          let breakAt = lineBuffer.indexOf("\n");
          while (breakAt !== -1) {
            processLine(lineBuffer.slice(0, breakAt));
            lineBuffer = lineBuffer.slice(breakAt + 1);
            breakAt = lineBuffer.indexOf("\n");
          }
        } else stdout += text;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => { finish(); reject(error); });
      child.once("close", (code) => {
        finish(); exitCode = code;
        if (lineBuffer.trim() && spec.outputFormat === "stream-json") processLine(lineBuffer.trim());
        resolve();
      });
    });
    await Promise.all(pending);
  } finally {
    plan.close();
  }
  if (timedOut || truncated || exitCode !== 0) {
    throw providerError(provider, timedOut ? "CLI turn timed out." : truncated
      ? "CLI output exceeded the bounded limit." : stderr || "CLI exited with code " + exitCode + ".");
  }
  const data = streamedResult ?? parseLastJson(stdout);
  if (!data) throw providerError(provider, "CLI did not return a valid final JSON result.");
  const status = getText(data, spec.statusField ?? "status");
  if (spec.successStatus && status !== spec.successStatus) {
    throw providerError(provider, getText(data, spec.errorField ?? "error") ?? "CLI failed with status " + status);
  }
  const denied = data[spec.deniedActionsField ?? "denied_actions"];
  if (Array.isArray(denied) && denied.length) throw providerError(provider, "CLI denied required actions; this turn is incomplete.");
  const response = getText(data, spec.responseField ?? "response");
  if (!response) throw providerError(provider, "CLI returned no final response.");
  const sessionId = getText(data, spec.sessionField ?? "conversation_id") ?? lastSessionId;
  if (sessionId && sessionId !== lastSessionId) await callbacks?.onSessionId?.(sessionId);
  const usage = readUsage(data[spec.usageField ?? "usage"]);
  return {
    provider,
    providerSessionId: sessionId ?? null,
    finalResponse: response,
    items: [{ type: "provider_json_result", data, toolEventsObserved: streamedEvents }],
    usage,
    outputBytes,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function getText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseLastJson(output: string): Record<string, unknown> | undefined {
  try { return asObject(JSON.parse(output.trim())); } catch { /* CLI may print a prefix before JSON. */ }
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]?.trimStart().startsWith("{")) continue;
    try { return asObject(JSON.parse(lines.slice(i).join("\n"))); } catch { /* Try prior boundary. */ }
  }
  return undefined;
}

function readUsage(value: unknown): CliAgentUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const number = (key: string): number | undefined => {
    const raw = usage[key];
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  };
  return {
    inputTokens: number("input_tokens"), outputTokens: number("output_tokens"),
    thinkingTokens: number("thinking_tokens"), cacheReadTokens: number("cache_read_tokens"),
    totalTokens: number("total_tokens"),
  };
}

function providerError(provider: string, message: string): AgentProviderExecutionError {
  return new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR", provider, operation: "run",
    retryable: false, message,
  });
}
