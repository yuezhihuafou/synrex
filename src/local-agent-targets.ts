import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { SubagentProviderConfig } from "./local-agent-config.js";
import type { AgentContextRequest } from "./local-agent-context-pack.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
  context?: AgentContextRequest;
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
  context?: AgentContextRequest;
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--workflow wf_id] [--context-file path] [--memory-project slug] [--context-ref ctx_id] "<prompt>"',
  );
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] "<prompt>"',
  );
  return {
    agentId: parsed.target, prompt: parsed.prompt, model: parsed.model,
    effort: parsed.effort, ...(parsed.context ? { context: parsed.context } : {}),
  };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  let context: AgentContextRequest | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--model") {
      const value = parseOptionValue(rest[index + 1], "--model");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = parseOptionValue(part.slice("--model=".length), "--model");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = parseOptionValue(rest[index + 1], "--effort");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = parseOptionValue(part.slice("--effort=".length), "--effort");
      effort = value;
      continue;
    }
    if (part === "--context") {
      context ??= {};
      continue;
    }
    const contextOption = [
      "--workflow", "--context-file", "--memory-project", "--context-ref", "--context-max-bytes",
    ].find((name) => part === name || part?.startsWith(name + "="));
    if (contextOption) {
      const value = parseOptionValue(part === contextOption ? rest[++index] : part?.slice(contextOption.length + 1), contextOption);
      context ??= {};
      switch (contextOption) {
        case "--workflow": context.workflowId = value; break;
        case "--context-file": (context.files ??= []).push(value); break;
        case "--memory-project": context.memoryProject = value; break;
        case "--context-ref": context.contextRef = value; break;
        case "--context-max-bytes": {
          const bytes = Number(value);
          if (!Number.isInteger(bytes) || bytes < 2_000 || bytes > 20_000) {
            throw new Error("--context-max-bytes must be between 2000 and 20000.");
          }
          context.maxBytes = bytes;
        }
      }
      continue;
    }
    if (part?.startsWith("-")) {
      throw unknownOptionError(part);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort, ...(context ? { context } : {}) };
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${option}.`);
  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);
  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model ?? providerConfig?.model,
      effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
      profile,
    };
  }

  if (isLocalAgentProvider(target) || providerConfigs.some((entry) => entry.id === target && entry.cli)) {
    const providerConfig = providerConfigs.find((entry) => entry.id === target);
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride ?? providerConfig?.model,
      effort: effortOverride ?? providerConfig?.effort,
    };
  }

  return undefined;
}
