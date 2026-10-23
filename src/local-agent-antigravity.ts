import { spawn } from "node:child_process";
import { captureAgentProviderResult, AgentProviderExecutionError } from "./local-agent-errors.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRuntime } from "./local-agent-runtime.js";

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
        return {
          provider: this.provider,
          isAlive: () => alive,
          close: async () => { alive = false; },
          releaseSession: async () => {},
          run: async (input: LocalAgentRunInput) => captureAgentProviderResult({
            provider: this.provider,
            operation: "run",
            run: async () => {
              // Gemini may reject gateway geography while Claude succeeds.
              // Default to a model with a verified working gateway path.
              const model = input.model ?? env.ANTIGRAVITY_MODEL ?? "claude-sonnet-4-6";
              const mode = input.writeMode === "read_only" ? "plan" : "accept-edits";
              const args = ["--mode", mode, "--model", model, "--print", input.prompt, "--output-format", "json", "--print-timeout", "180s"];
              const output = await new Promise<string>((resolve, reject) => {
                const child = spawn(command, args, { cwd: input.workspaceRoot, env, stdio: ["ignore", "pipe", "pipe"] });
                let stdout = "";
                let stderr = "";
                const deadline = setTimeout(() => child.kill("SIGTERM"), 190_000);
                child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
                child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
                child.on("error", (error) => { clearTimeout(deadline); reject(error); });
                child.on("close", (code) => {
                  clearTimeout(deadline);
                  if (code !== 0 && !stdout.trim()) reject(new Error(stderr.slice(-2000) || `Antigravity exited ${code}`));
                  else resolve(stdout);
                });
              });
              const line = output.trim().split("\n").reverse().find((text) => text.trim().startsWith("{"));
              let data: { status?: string; response?: string; error?: string; conversation_id?: string };
              try { data = JSON.parse(line ?? ""); }
              catch { throw new Error("Antigravity returned invalid JSON"); }
              if (data.status !== "SUCCESS") {
                throw new AgentProviderExecutionError({
                  code: "PROVIDER_EXECUTION_ERROR", provider: this.provider,
                  operation: "run", retryable: false,
                  message: data.error || `Antigravity failed with status ${data.status}`,
                });
              }
              // The CLI JSON conversation id is not a verified resumable headless session.
              return { provider: this.provider, providerSessionId: null, finalResponse: data.response ?? "", items: [] };
            },
          }),
        };
      },
    });
  }
}
