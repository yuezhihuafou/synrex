import * as z from "zod/v4";
import { subagentsConfigSchema } from "./local-agent-config.js";

export const DEVSPACE_CONFIG_VERSION = 1 as const;
export const DEVSPACE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/yuezhihuafou/synrex/main/schema/v1/devspace.schema.json";

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7676),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.boolean().default(false),
}).strict().prefault({});

const nodeConfigSchema = z.object({
  alias: z.string().trim().min(1).nullable().default(null),
  labels: z.record(z.string(), z.string()).default({}),
}).strict().prefault({});

const placementRuleSchema = z.object({
  id: z.string().trim().min(1),
  pathPrefix: z.string().trim().min(1),
  mode: z.enum(["require", "prefer"]).default("require"),
  node: z.string().trim().min(1).optional(),
  labels: z.record(z.string(), z.string()).default({}),
}).strict().refine(
  (value) => value.node !== undefined || Object.keys(value.labels).length > 0,
  "Placement rule requires node or at least one label.",
);

const clusterConfigSchema = z.object({
  role: z.enum(["standalone", "coordinator", "peer", "gateway", "worker"]).default("standalone"),
  gatewayUrl: z.string().url().nullable().default(null),
  gatewayFallbackUrl: z.string().url().nullable().default(null),
  // Ordinary ChatGPT MCP clients may close a tool HTTP request at ~120s.
  // Default below that boundary; callers with longer-lived transports may
  // explicitly opt into a larger deadline. Undelivered requests fail sooner.
  requestTimeoutMs: z.number().int().min(5_000).max(30 * 60_000).default(100_000),
  pollWaitMs: z.number().int().min(1_000).max(30_000).default(25_000),
  heartbeatMs: z.number().int().min(1_000).max(60_000).default(15_000),
  suspectAfterMs: z.number().int().min(5_000).max(10 * 60_000).default(45_000),
  offlineAfterMs: z.number().int().min(10_000).max(60 * 60_000).default(120_000),
  placementRules: z.array(placementRuleSchema).default([]),
  projectBindings: z.array(z.object({
    project: z.string().trim().min(1),
    node: z.string().trim().min(1),
    pathPrefix: z.string().trim().min(1),
  }).strict()).default([]),
}).strict().superRefine((value, context) => {
  if ((value.role === "worker" || value.role === "peer") && !value.gatewayUrl) {
    context.addIssue({
      code: "custom",
      path: ["gatewayUrl"],
      message: "cluster.gatewayUrl is required when cluster.role is peer (legacy: worker).",
    });
  }
  if (value.offlineAfterMs <= value.suspectAfterMs) {
    context.addIssue({
      code: "custom",
      path: ["offlineAfterMs"],
      message: "cluster.offlineAfterMs must be greater than cluster.suspectAfterMs.",
    });
  }
  const ids = new Set<string>();
  for (const [index, rule] of value.placementRules.entries()) {
    if (ids.has(rule.id)) {
      context.addIssue({
        code: "custom",
        path: ["placementRules", index, "id"],
        message: `Duplicate placement rule id: ${rule.id}.`,
      });
    }
    ids.add(rule.id);
  }
}).prefault({});

const workspacesConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  worktreeRoot: z.string().trim().min(1).default("~/.devspace/worktrees"),
}).strict().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/devspace"),
  metadataRetentionDays: z.number().int().positive().default(90),
}).strict().prefault({});

const toolsConfigSchema = z.object({
  mode: z.enum(["claude", "codex"]).default("codex"),
}).strict().prefault({});

const uiConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).strict().prefault({});

const artifactsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(100 * 1024 * 1024),
}).strict().prefault({});

const skillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string().trim().min(1)).default([]),
  agentDir: z.string().trim().min(1).default("~/.codex"),
}).strict().prefault({});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  requests: z.boolean().default(true),
  assets: z.boolean().default(false),
  toolCalls: z.boolean().default(true),
  shellCommands: z.boolean().default(false),
}).strict().prefault({});

const oauthConfigSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["devspace"]),
  allowedResourceUrls: z.array(z.string().trim().url().refine((value) => {
    const url = URL.parse(value);
    return url !== null && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }, "Resource URLs must use HTTPS, or HTTP on localhost, 127.0.0.1, or [::1]")
    .describe("Exact resource URL: HTTPS, or HTTP on localhost, 127.0.0.1, or [::1]."))
    .default([]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "chatgpt.com",
    "localhost",
    "127.0.0.1",
  ]),
}).strict().prefault({});

const mcpServerNameSchema = z.string().trim().regex(
  /^[a-z][a-z0-9_-]{0,31}$/,
  "MCP server names must start with a lowercase letter and contain only lowercase letters, digits, '_' or '-'.",
);

const mcpServerBaseSchema = z.object({
  name: mcpServerNameSchema,
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
});

const mcpStdioServerSchema = mcpServerBaseSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(4_096)).max(64).default([]),
  cwd: z.string().trim().min(1).max(4_096).optional(),
  env: z.record(z.string(), z.string().max(16_384)).default({}),
}).strict();

const mcpStreamableHttpServerSchema = mcpServerBaseSchema.extend({
  transport: z.literal("streamable-http"),
  url: z.string().trim().url().refine((value) => {
    const url = URL.parse(value);
    return url !== null
      && !url.username
      && !url.password
      && (url.protocol === "https:"
        || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }, "MCP server URLs must use HTTPS or HTTP on loopback and must not include URL credentials."),
  headers: z.record(z.string(), z.string().max(16_384)).default({}),
}).strict();

const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpStreamableHttpServerSchema,
]);

const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).max(16).default([]),
}).strict().superRefine((value, context) => {
  const names = new Set<string>();
  for (const [index, server] of value.servers.entries()) {
    if (names.has(server.name)) {
      context.addIssue({
        code: "custom",
        path: ["servers", index, "name"],
        message: `Duplicate MCP server name: ${server.name}.`,
      });
    }
    names.add(server.name);
  }
}).prefault({});

export const devspaceConfigSchema = z.object({
  $schema: z.string().url().default(DEVSPACE_CONFIG_SCHEMA_URL),
  configVersion: z.literal(DEVSPACE_CONFIG_VERSION),
  server: serverConfigSchema,
  node: nodeConfigSchema,
  cluster: clusterConfigSchema,
  workspaces: workspacesConfigSchema,
  storage: storageConfigSchema,
  tools: toolsConfigSchema,
  taskContinuity: z.object({ enabled: z.boolean().default(true) }).strict().prefault({}),
  ui: uiConfigSchema,
  artifacts: artifactsConfigSchema,
  skills: skillsConfigSchema,
  subagents: subagentsConfigSchema.default({
    enabled: false,
    instructions: "on-demand",
    providers: [],
  }),
  logging: loggingConfigSchema,
  oauth: oauthConfigSchema,
  mcp: mcpConfigSchema,
}).strict();

export type DevspaceConfig = z.output<typeof devspaceConfigSchema>;
export type DevspaceConfigInput = z.input<typeof devspaceConfigSchema>;
export type ToolMode = DevspaceConfig["tools"]["mode"];
export type McpConfig = DevspaceConfig["mcp"];
export type McpServerConfig = McpConfig["servers"][number];

export function defaultDevspaceConfig(): DevspaceConfig {
  return devspaceConfigSchema.parse({ configVersion: DEVSPACE_CONFIG_VERSION });
}

export function devspaceConfigJsonSchema(): object {
  return {
    $id: DEVSPACE_CONFIG_SCHEMA_URL,
    title: "Synrex configuration",
    description: "Versioned configuration for a local Synrex MCP server.",
    ...z.toJSONSchema(devspaceConfigSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
