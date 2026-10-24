import { spawn, type ChildProcess } from "node:child_process";
import { captureAgentProviderResult, AgentProviderExecutionError } from "./local-agent-errors.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRuntime } from "./local-agent-runtime.js";
import { prepareAntigravityExecution } from "./local-agent-antigravity-sandbox.js";

/** Stateless headless Antigravity adapter. Never silently retries API failures. */
export class AntigravityLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "antigravity" as const;
  readonly idleTimeoutMs = 60_000;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  runtimeKey(): string {
    return `antigravity:${this.env.ANTIGRAVITY_COMMAND ?? "agy"}`;
  }

  async createRuntime() {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.env.ANTIGRAVITY_COMMAND ?? "agy";
        const env = { ...this.env };
        let alive = true;
        let activeChild: ChildProcess | undefined;
        let forceTimer: NodeJS.Timeout | undefined;
        const terminate = () => {
          if (!activeChild) return;
          activeChild.kill("SIGTERM");
          forceTimer ??= setTimeout(() => activeChild?.kill("SIGKILL"), 5_000);
          forceTimer.unref();
        };
        return {
          provider: this.provider,
          isAlive: () => alive,
          close: async () => { alive = false; terminate(); },
          releaseSession: async () => {},
          run: async (input: LocalAgentRunInput) => captureAgentProviderResult({
            provider: this.provider,
            operation: "run",
            run: async () => {
              if (!alive) throw new Error("Antigravity runtime is closed.");
              const model = input.model ?? env.ANTIGRAVITY_MODEL ?? "gemini-3.8-flash-medium";
              // read_only is enforced by the mount namespace, not by the
              // provider's plan mode. Plan mode may suppress actual terminal
              // inspection. Use the same non-interactive tool mode for both.
              const mode = "accept-edits";
              // In Headless mode, accept-edits alone soft-denies terminal
              // commands. Approve all provider tools only inside a filesystem
              // namespace. The native Antigravity --sandbox flag alone did
              // not prevent an outside-workspace write in our actual test.
              const args = [
                "--mode", mode, "--dangerously-skip-permissions",
                "--model", model, "--print", input.prompt,
                "--output-format", "json", "--print-timeout", "180s",
              ];
              const execution = prepareAntigravityExecution({
                workspaceRoot: input.workspaceRoot,
                providerCommand: command,
                providerArgs: args,
                writeMode: input.writeMode,
                env,
              });
              let output: string;
              try {
                output = await new Promise<string>((resolve, reject) => {
                const child = spawn(execution.command, execution.args, {
                  cwd: input.workspaceRoot, env: execution.env,
                  stdio: ["ignore", "pipe", "pipe"],
                });
                activeChild = child;
                let stdout = "";
                let stderr = "";
                const deadline = setTimeout(terminate, 190_000);
                child.stdout.on("data", (chunk: Buffer) => {
                  stdout += chunk.toString();
                  if (stdout.length > 2_000_000) terminate();
                });
                child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
                child.on("error", (error) => {
                  clearTimeout(deadline);
                  activeChild = undefined;
                  reject(error);
                });
                child.on("close", (code) => {
                  clearTimeout(deadline);
                  if (forceTimer) { clearTimeout(forceTimer); forceTimer = undefined; }
                  activeChild = undefined;
                  if (code !== 0 && !stdout.trim()) reject(new Error(stderr.slice(-2000) || `Antigravity exited ${code}`));
                  else resolve(stdout);
                });
                });
              } finally {
                execution.close();
              }
              const lines = output.trim().split(/\r?\n/);
              let data: {
                status?: string; response?: string; error?: string; conversation_id?: string;
                denied_actions?: unknown[];
              } | undefined;
              for (let index = lines.length - 1; index >= 0; index--) {
                if (!lines[index].trimStart().startsWith("{")) continue;
                try { data = JSON.parse(lines.slice(index).join("\n")); break; }
                catch { /* Try the previous JSON boundary. */ }
              }
              if (!data) throw new Error("Antigravity returned invalid JSON.");
              if (data.status !== "SUCCESS") {
                throw new AgentProviderExecutionError({
                  code: "PROVIDER_EXECUTION_ERROR", provider: this.provider,
                  operation: "run", retryable: false,
                  message: data.error || `Antigravity failed with status ${data.status}`,
                  cause: { providerJson: data },
                });
              }
              // The provider may report SUCCESS after rejecting all requested
              // commands. An empty answer plus explicit denied actions is a
              // failed turn, not a completed engineering task.
              if (Array.isArray(data.denied_actions) && data.denied_actions.length > 0) {
                throw new AgentProviderExecutionError({
                  code: "PROVIDER_EXECUTION_ERROR", provider: this.provider,
                  operation: "run", retryable: false,
                  message: "Antigravity denied required actions; this turn is incomplete.",
                  cause: { providerJson: data },
                });
              }
              // Provider JSON is an actual observed result, NOT a tool-event
              // trace or proof of passing tests. Preserve it for the owner.
              return {
                provider: this.provider,
                providerSessionId: null,
                finalResponse: data.response ?? "",
                items: [{ type: "provider_json_result", data, toolEventsObserved: false }],
              };
            },
          }),
        };
      },
    });
  }
}
