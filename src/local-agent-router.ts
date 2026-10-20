import type { LocalAgentCatalog } from "./local-agent-catalog.js";

export interface AutoAgentRoute {
  target: string;
  reason: string;
}

export function routeAutoAgent(
  prompt: string,
  catalog: LocalAgentCatalog,
): AutoAgentRoute {
  const localProfile = catalog.profiles.find((profile) => profile.name === "local-operator");
  const codex = catalog.providers.find((provider) => provider.id === "codex" && provider.usable);

  if (localProfile && isBoundedReadOnlyTask(prompt)) {
    return {
      target: localProfile.name,
      reason: "bounded-read-only",
    };
  }
  if (codex) {
    return {
      target: "codex",
      reason: localProfile ? "complex-or-mutating" : "local-operator-unavailable",
    };
  }
  if (localProfile) {
    return {
      target: localProfile.name,
      reason: "codex-unavailable",
    };
  }
  const profile = catalog.profiles[0];
  if (profile) return { target: profile.name, reason: "fallback-profile" };
  const provider = catalog.providers.find((candidate) => candidate.usable);
  if (provider) return { target: provider.id, reason: "fallback-provider" };
  throw new Error("No usable subagent target is available for automatic routing.");
}

export function isBoundedReadOnlyTask(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized || normalized.length > 1_800) return false;

  const explicitNoWrite = /\b(do not edit|don't edit|no edits?|read[- ]only|without changing|without modifying)\b/g;
  const intentText = normalized.replace(explicitNoWrite, " ");
  const mutating = /\b(edit|modify|fix|implement|refactor|rewrite|patch|write|create|add|remove|delete|rename|move|install|upgrade|deploy|commit|merge|rebase|push|change|update)\b/;
  const complex = /\b(architecture|architect|design|research|benchmark|migration|multi[- ]?module|cross[- ]?module|root cause|debug|performance|security|production)\b/;
  if (mutating.test(intentText) || complex.test(normalized)) return false;

  const readOnlySignal = /\b(read|inspect|report|summarize|summary|find|locate|list|show|explain|check|identify|compare|what|which|where|how many)\b/;
  return readOnlySignal.test(normalized) || explicitNoWrite.test(normalized);
}
