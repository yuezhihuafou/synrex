import type { SubagentsConfig } from "./local-agent-config.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add Waishnav/devspace --skill subagents --global";

export const ONBOARDING_DESTINATIONS = ["chatgpt", "coding-agents"] as const;
export type OnboardingDestination = typeof ONBOARDING_DESTINATIONS[number];
export type OnboardingUsage = OnboardingDestination | "both";

export function resolveOnboardingUsage(
  destinations: readonly OnboardingDestination[],
): OnboardingUsage {
  const selected = new Set(destinations);
  if (selected.has("chatgpt") && selected.has("coding-agents")) return "both";
  if (selected.has("chatgpt")) return "chatgpt";
  if (selected.has("coding-agents")) return "coding-agents";
  throw new Error("Choose ChatGPT, Coding Agents, or both.");
}

export function usesChatGpt(usage: OnboardingUsage): boolean {
  return usage === "chatgpt" || usage === "both";
}

export function usesCodingAgents(usage: OnboardingUsage): boolean {
  return usage === "coding-agents" || usage === "both";
}

/** Persist project roots without requiring first-time setup again. */
export function updateAllowedRoots(
  current: readonly string[],
  action: "add" | "remove",
  paths: readonly string[],
): string[] {
  if (!paths.length) throw new Error("Provide at least one project root.");
  const unique = [...new Set(current)];
  if (action === "add") return [...new Set([...unique, ...paths])];
  const remaining = unique.filter((root) => !paths.includes(root));
  if (!remaining.length) throw new Error("Cannot remove the last allowed project root.");
  return remaining;
}

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  return {
    enabled: true,
    instructions: current.instructions,
    providers: LOCAL_AGENT_PROVIDERS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);
        return {
          ...existing,
          id,
          enabled: selected.has(id),
        };
      }),
  };
}
