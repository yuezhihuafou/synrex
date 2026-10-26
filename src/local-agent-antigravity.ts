import { GenericCliAgentDriver, type CliAgentSpec } from "./local-agent-cli.js";

/** Only the Antigravity CLI contract lives here; execution is shared by all headless CLI providers. */
export const ANTIGRAVITY_CLI_SPEC: CliAgentSpec = {
  command: "agy",
  args: [
    "--mode", "accept-edits", "--dangerously-skip-permissions",
    "--output-format", "stream-json", "--print-timeout", "180s",
  ],
  outputFormat: "stream-json",
  modelFlag: "--model",
  effortFlag: "--effort",
  sessionFlag: "--conversation",
  promptFlag: "--print",
  statusField: "status",
  successStatus: "SUCCESS",
  responseField: "response",
  sessionField: "conversation_id",
  errorField: "error",
  deniedActionsField: "denied_actions",
  usageField: "usage",
  isolation: "antigravity",
  timeoutMs: 190_000,
};

/** Backward-compatible built-in AGY target, now using the generic CLI driver. */
export class AntigravityLocalAgentDriver extends GenericCliAgentDriver {
  constructor(env: NodeJS.ProcessEnv = process.env, stateDir?: string) {
    super("antigravity", {
      ...ANTIGRAVITY_CLI_SPEC,
      command: env.ANTIGRAVITY_COMMAND ?? "agy",
      defaultModel: env.ANTIGRAVITY_MODEL ?? "gemini-3.8-flash-medium",
    }, env, stateDir);
  }
}
