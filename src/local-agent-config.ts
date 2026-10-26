import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

/** Optional declarative runner for new headless CLIs; no TypeScript adapter required. */
const cliSpecSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  defaultModel: z.string().trim().min(1).optional(),
  outputFormat: z.enum(["json", "stream-json"]).optional(),
  promptFlag: z.string().trim().min(1).optional(),
  modelFlag: z.string().trim().min(1).optional(),
  effortFlag: z.string().trim().min(1).optional(),
  sessionFlag: z.string().trim().min(1).optional(),
  statusField: z.string().trim().min(1).optional(),
  successStatus: z.string().trim().min(1).optional(),
  responseField: z.string().trim().min(1).optional(),
  sessionField: z.string().trim().min(1).optional(),
  errorField: z.string().trim().min(1).optional(),
  deniedActionsField: z.string().trim().min(1).optional(),
  usageField: z.string().trim().min(1).optional(),
  isolation: z.enum(["none", "antigravity"]).default("none"),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
}).strict();

const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  cli: cliSpecSchema.optional(),
}).strict();

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  providers: z.array(providerSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProvider>();
  for (const [index, provider] of value.providers.entries()) {
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate subagent provider: ${provider.id}`,
      });
    }
    seen.add(provider.id);
    if (!LOCAL_AGENT_PROVIDERS.includes(provider.id) && !provider.cli) {
      context.addIssue({
        code: "custom", path: ["providers", index, "cli"],
        message: `Unknown provider ${provider.id} requires a CLI specification.`,
      });
    }
    if (LOCAL_AGENT_PROVIDERS.includes(provider.id) && provider.cli) {
      context.addIssue({
        code: "custom", path: ["providers", index, "cli"],
        message: `Built-in provider ${provider.id} cannot override its driver through CLI configuration.`,
      });
    }
  }
});

export const storedSubagentsConfigSchema = z.union([
  z.boolean(),
  subagentsConfigSchema,
]);

export type SubagentProviderConfig = z.infer<typeof providerSchema>;
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
export type StoredSubagentsConfig = z.infer<typeof storedSubagentsConfigSchema>;

export function subagentProviderConfig(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === provider);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): boolean {
  return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}
