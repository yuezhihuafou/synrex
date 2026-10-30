import {
  AcpLocalAgentDriver,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
} from "./local-agent-acp.js";
import {
  ClaudeLocalAgentDriver,
  claudeCommandEnvironment,
  type ClaudeQueryFactory,
} from "./local-agent-claude.js";
import { CodexLocalAgentDriver } from "./local-agent-codex.js";
import { AntigravityLocalAgentDriver } from "./local-agent-antigravity.js";
import { GenericCliAgentDriver } from "./local-agent-cli.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import {
  OpencodeLocalAgentDriver,
  extractOpenCodeFinalResponse,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import {
  PiLocalAgentDriver,
  extractPiFinalResponse,
  extractPiProviderError,
  type PiSessionFactory,
} from "./local-agent-pi.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";

export type LocalAgentAdapter = LocalAgentDriver;

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piSessionFactory?: PiSessionFactory;
  subagents?: SubagentsConfig;
  stateDir?: string;
}

export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  return [
    new CodexLocalAgentDriver(options.env),
    new AntigravityLocalAgentDriver(options.env, options.stateDir),
    new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env),
    new OpencodeLocalAgentDriver(options.opencodeFactory),
    new PiLocalAgentDriver(options.piSessionFactory),
    new AcpLocalAgentDriver("cursor", options.env),
    new AcpLocalAgentDriver("copilot", options.env),
    new AcpLocalAgentDriver("grok", options.env),
    ...(options.subagents?.providers.filter((entry) => entry.cli).map((entry) =>
      new GenericCliAgentDriver(entry.id, entry.cli!, options.env, options.stateDir)) ?? []),
  ];
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

export {
  claudeCommandEnvironment,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
};
