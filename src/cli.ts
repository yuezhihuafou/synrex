#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { Result as BetterResult } from "better-result";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { routeAutoAgent } from "./local-agent-router.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import {
  type OnboardingDestination,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValue,
  setDevspaceConfigValues,
  writeDevspaceAuth,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { readReviewRef } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { logEvent } from "./logger.js";
import { DiagnosticTrace, summarizeDiagnosticTrace } from "./diagnostic-trace.js";
import { diagnosticTimings, readRunTrace, systemDiagnosticEvents } from "./diagnostic-report.js";
import { inspectOAuthState } from "./oauth-diagnostics.js";
import { getOAuthEnrollmentStatus, lockOAuthEnrollment, openOAuthEnrollmentWindow, usePasswordOnlyEnrollment } from "./oauth-enrollment.js";
import { pruneStaleManagedWorktrees } from "./worktree-prune.js";
import { pruneStaleWorkspaceMetadata } from "./workspace-retention.js";
import { generateNodeJoinToken } from "./multinode/auth.js";
import { NodeHealthMonitor } from "./multinode/health.js";
import { localNodeRegistration } from "./multinode/local-node.js";
import { compareToolContracts } from "./multinode/protocol.js";
import { SqliteControlPlaneStore } from "./multinode/store.js";
import { nodeApiUrl } from "./multinode/worker-client.js";
import { DurableTaskManager } from "./durable-tasks.js";
import { runWorkflowCommand } from "./workflow-cli.js";
import { SerenaSemanticManager } from "./serena-semantic.js";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "oauth"
  | "config"
  | "worktrees"
  | "agents"
  | "nodes"
  | "workflow"
  | "diagnose"
  | "show-changes"
  | "help"
  | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor(args.includes("--auth"));
      return;
    case "oauth":
      runOAuthCommand(args);
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "worktrees":
      await runWorktreesCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "nodes":
      await runNodesCommand(args);
      return;
    case "workflow":
      await runWorkflowCommand(args, loadConfig());
      return;
    case "diagnose": {
      const summaryOnly = args.includes("--summary");
      const withSystem = args.includes("--system");
      const diagnoseArgs = args.filter((arg) => arg !== "--summary" && arg !== "--system");
      const options = new Map<string, string>();
      for (let i = 0; i < diagnoseArgs.length; i += 2) {
        if (i + 1 >= diagnoseArgs.length || !["--minutes", "--conversation", "--title", "--request", "--run"].includes(diagnoseArgs[i]!)
          || options.has(diagnoseArgs[i]!) || !diagnoseArgs[i + 1]) {
          throw new Error("Usage: synrex diagnose [--minutes 1-1440] [--conversation conv_<id>] [--title <exact title>] [--request <id>] [--run <run_id>] [--summary]");
        }
        options.set(diagnoseArgs[i]!, diagnoseArgs[i + 1]!);
      }
      const rawMinutes = options.get("--minutes");
      const minutes = rawMinutes === undefined ? 30 : Number(rawMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw new Error("Diagnostic range must be between 1 and 1440 minutes");
      }
      const conversationId = options.get("--conversation");
      if (conversationId && !/^conv_[0-9a-f]{32}$/.test(conversationId)) {
        throw new Error("Invalid conversation diagnostic identifier");
      }
      const requestId = options.get("--request");
      if (requestId && !/^[a-zA-Z0-9_-]{1,110}$/.test(requestId)) throw new Error("Invalid request identifier");
      let traces = new DiagnosticTrace(loadConfig().stateDir).read({
        minutes, limit: requestId || summaryOnly ? 20_000 : 120, conversationId, title: options.get("--title"), requestId,
      });
      const runs = new Set(traces.flatMap((entry) => entry.runId ? [entry.runId] : []));
      if (options.has("--run")) runs.add(options.get("--run")!);
      for (const runId of [...runs].slice(-50)) traces.push(...readRunTrace(runId));
      traces = traces.sort((a, b) => a.ts.localeCompare(b.ts));
      const report = summarizeDiagnosticTrace(traces);
      console.log(JSON.stringify({ minutes, count: traces.length, ...report,
        window: { firstEventAt: traces[0]?.ts ?? null, lastEventAt: traces.at(-1)?.ts ?? null, queriedMinutes: minutes },
        requestCount: report.requests.length, requests: summaryOnly ? report.requests.slice(-20) : report.requests,
        timings: diagnosticTimings(traces),
        ...(summaryOnly ? {} : { events: traces }),
        ...(withSystem ? { system: systemDiagnosticEvents(minutes) } : {}),
        limits: ["HTTP finish is local flush, not client receipt", "ChatGPT scheduling, reasoning and UI are not observable", "Cloudflare edge timing requires separate edge logs", "Rotated windows can omit earlier stages; remote run traces are on their owner node"],
      }, null, 2));
      return;
    }
    case "show-changes":
      await runShowChanges(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "init"
    || command === "doctor"
    || command === "oauth"
    || command === "config"
    || command === "worktrees"
    || command === "agents"
    || command === "nodes"
    || command === "workflow"
    || command === "diagnose"
    || command === "show-changes"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.migratedLegacyConfig) {
    console.log(`Migrated legacy configuration to ${files.configPath}`);
  }
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "Synrex is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  synrex init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`Synrex is already configured at ${files.dir}`);
    prompts.log.info("Run `synrex init --force` to update it.");
    return;
  }

  try {
    prompts.intro("Synrex setup");

    const destinationAnswer = await prompts.multiselect({
      message: "Where will you use Synrex?",
      options: [
        {
          value: "chatgpt",
          label: "ChatGPT",
          hint: "Connect ChatGPT to projects on this computer.",
        },
        {
          value: "coding-agents",
          label: "Coding Agents",
          hint: "Use Synrex from Codex, Claude Code, OpenCode, Pi, and similar tools.",
        },
      ],
      initialValues: files.config.server.publicBaseUrl ? ["chatgpt"] : ["coding-agents"],
      required: true,
    });
    if (prompts.isCancel(destinationAnswer)) throw new SetupCancelledError();
    const usage = resolveOnboardingUsage(destinationAnswer as OnboardingDestination[]);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    if (useChatGpt) {
      const defaultRoots = files.config.workspaces.allowedRoots.join(", ") || process.cwd();
      const rootsAnswer = await textPrompt({
        message: `Which project folders can Synrex access? Press Enter to use ${defaultRoots}`,
        placeholder: defaultRoots,
        defaultValue: defaultRoots,
        validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
      });
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
    }

    const port = files.config.server.port;

    let publicBaseUrl: string | null = null;
    if (useChatGpt) {
      prompts.note(
        [
          `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
          "Paste its public URL below.",
          "",
          "Example: https://your-tunnel-host.example.com",
        ].join("\n"),
        "Connect ChatGPT",
      );
      publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
        message: files.config.server.publicBaseUrl
          ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.server.publicBaseUrl}`
          : "What public URL will ChatGPT connect to?",
        placeholder: files.config.server.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.server.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }));
    }

    const currentSubagents = files.config.subagents;
    const availability = getLocalAgentProviderAvailabilitySnapshot(process.env, currentSubagents);
    const configuredProviders = currentSubagents.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id);
    const initialValues = configuredProviders.length > 0
      ? configuredProviders
      : availability
          .filter((provider) => provider.available)
          .map((provider) => provider.name);
    const providerAnswer = await prompts.multiselect({
      message: "Which Coding Agents should be available?",
      options: availability.map((provider) => ({
        value: provider.name,
        label: provider.name,
        hint: provider.available
          ? provider.note ?? "available"
          : `unavailable: ${provider.reason ?? "provider preflight failed"}`,
      })),
      initialValues,
      required: true,
    });
    if (prompts.isCancel(providerAnswer)) throw new SetupCancelledError();
    const selectedProviders = providerAnswer as LocalAgentProvider[];
    const subagents = updateOnboardingSubagentsConfig(
      currentSubagents,
      selectedProviders,
    );

    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    setDevspaceConfigValues([
      { path: ["server", "port"], value: port },
      ...(useChatGpt
        ? [{ path: ["server", "publicBaseUrl"], value: publicBaseUrl }]
        : []),
      ...(allowedRoots
        ? [{ path: ["workspaces", "allowedRoots"], value: allowedRoots }]
        : []),
      { path: ["subagents"], value: subagents },
    ]);
    writeDevspaceAuth(auth);

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Coding Agents: ${selectedProviders.join(", ")}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "Synrex is ready");
    if (useChatGpt) {
      prompts.note(
        [
          `Owner password: ${auth.ownerToken}`,
          "Use this when ChatGPT asks you to approve Synrex access.",
        ].join("\n"),
        "Owner password",
      );
    }
    if (useCodingAgents) {
      prompts.note(
        [
          SUBAGENT_SKILL_INSTALL_COMMAND,
          "",
          "The Skills CLI will let you choose which Coding Agents receive it.",
        ].join("\n"),
        "Install the Subagents skill",
      );
    }
    const nextSteps = [
      useChatGpt ? "Run `synrex serve`, then connect ChatGPT." : undefined,
      useCodingAgents ? "Run the skill command above before delegating from your Coding Agents." : undefined,
    ].filter(Boolean).join(" ");
    prompts.outro(nextSteps);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const config = loadConfig();
  await runStartupWorktreeCleanup(config);
  await runStartupMetadataCleanup(config);
  const { createServer } = await import("./server.js");
  const { app, close, localAgentProviders, localNode } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`synrex listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because server.allowedHosts contains '*'");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`cluster: ${config.cluster.role}${config.cluster.gatewayUrl ? ` -> ${config.cluster.gatewayUrl}` : ""}`);
    console.log(`node: ${localNode.alias ? `${localNode.alias} (${localNode.id})` : localNode.id}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("synrex shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runStartupWorktreeCleanup(config: ServerConfig): Promise<void> {
  try {
    const cleanup = await pruneStaleManagedWorktrees(config);
    if (cleanup.isErr()) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        error: cleanup.error.message,
        operation: cleanup.error.operation,
      });
      return;
    }

    const result = cleanup.value;
    const preserved = result.removed.filter((entry) => entry.recoveryRef).length;
    if (result.removed.length > 0 || result.missing.length > 0 || result.skipped.length > 0) {
      logEvent(config.logging, "info", "managed_worktree_cleanup", {
        removed: result.removed.length,
        recoveryRefs: preserved,
        missingSessions: result.missing.length,
        skippedUntracked: result.skipped.length,
      });
    }
    for (const failure of result.failed) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        workspaceId: failure.workspaceId,
        error: failure.error.message,
        operation: failure.error.operation,
      });
    }
  } catch (error) {
    logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runStartupMetadataCleanup(config: ServerConfig): Promise<void> {
  try {
    const cleanup = await pruneStaleWorkspaceMetadata(config);
    if (cleanup.isErr()) {
      logEvent(config.logging, "warn", "workspace_metadata_cleanup_failed", {
        error: cleanup.error.message,
        operation: cleanup.error.operation,
      });
      return;
    }
    if (cleanup.value.sessions > 0 || cleanup.value.conversationBindings > 0) {
      logEvent(config.logging, "info", "workspace_metadata_cleanup", { ...cleanup.value });
    }
  } catch (error) {
    logEvent(config.logging, "warn", "workspace_metadata_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runDoctor(includeAuthDiagnostics = false): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Cluster role: ${config.cluster.role}`);
    if (config.cluster.gatewayUrl) console.log(`Cluster gateway: ${config.cluster.gatewayUrl}`);
    if (!includeAuthDiagnostics) {
      const nodeStore = new SqliteControlPlaneStore(config.stateDir);
      try {
        const local = nodeStore.listNodes().find((node) => node.kind === "local");
        if (local) console.log(`Execution node: ${local.alias ? `${local.alias} (${local.id})` : local.id}`);
        console.log(`Known execution nodes: ${nodeStore.listNodes().length}`);
      } finally {
        nodeStore.close();
      }
    }
    if (includeAuthDiagnostics) {
      const enrollment = getOAuthEnrollmentStatus(config.stateDir);
      console.log(`OAuth enrollment: ${enrollment.locked ? (enrollment.acceptingNewConnections ? "temporary window open" : "locked") : "password-gated (no enrollment timer)"}`);
      const snapshot = inspectOAuthState(config.stateDir);
      console.log(`OAuth state path: ${config.stateDir}`);
      console.log(`OAuth database: ${snapshot.databaseExists ? "present" : "missing"}`);
      console.log(`OAuth registered clients: ${snapshot.clients}`);
      console.log(`OAuth active access tokens: ${snapshot.activeAccessTokens}`);
      console.log(`OAuth active refresh tokens: ${snapshot.activeRefreshTokens}`);
      console.log(`OAuth pending authorization codes: ${snapshot.activeAuthorizationCodes}`);
      if (snapshot.soonestRefreshExpiry !== undefined) {
        console.log(`OAuth earliest refresh expiry (UTC): ${new Date(snapshot.soonestRefreshExpiry * 1000).toISOString()}`);
      }
      if (snapshot.clients > 0 && snapshot.activeRefreshTokens === 0) {
        console.warn("OAuth warning: no usable refresh tokens remain in this state database; an existing client may require re-authorization.");
      }
      if (config.stateDir.includes(".devspace-dev")) {
        console.warn("OAuth QA warning: this is a development state directory, not the production OAuth database.");
      }
    }
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runOAuthCommand(args: string[]): void {
  const [subcommand, ...rest] = args;
  const stateDir = loadConfig().stateDir;
  if (subcommand === "password-only" && rest.length === 0) {
    usePasswordOnlyEnrollment(stateDir);
    console.log("Password-gated OAuth enabled without enrollment windows; existing tokens preserved.");
    return;
  }
  if (subcommand === "lock" && rest.length === 0) {
    lockOAuthEnrollment(stateDir);
    console.log("OAuth new-client enrollment locked; existing access and refresh tokens remain valid.");
    return;
  }
  if (subcommand === "window" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--once"))) {
    const minutes = Number(rest[0]);
    const until = openOAuthEnrollmentWindow(stateDir, minutes, Date.now(), { closeAfterGrant: rest[1] === "--once" });
    console.log(`OAuth new-client enrollment open until ${new Date(until).toISOString()} (automatically closes).`);
    return;
  }
  if (subcommand === "status" && rest.length === 0) {
    const status = getOAuthEnrollmentStatus(stateDir);
    console.log(`OAuth enrollment: ${status.locked ? (status.acceptingNewConnections ? "temporary window open" : "locked") : "password-gated (no enrollment timer)"}`);
    if (status.allowUntilMs) console.log(`Window expires: ${new Date(status.allowUntilMs).toISOString()}`);
    return;
  }
  throw new Error("Usage: synrex oauth password-only | synrex oauth lock | synrex oauth window <minutes 1-15> | synrex oauth status");
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `synrex config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  setDevspaceConfigValue(
    ["server", "publicBaseUrl"],
    normalizeOptionalPublicBaseUrl(value),
  );
  console.log(`Updated ${files.configPath}`);
}

async function runWorktreesCommand(args: string[]): Promise<void> {
  const [subcommand, ...extra] = args;
  if (subcommand !== "prune" || extra.length > 0) {
    throw new Error("Usage: synrex worktrees prune");
  }

  const cleanup = await pruneStaleManagedWorktrees(loadConfig());
  if (cleanup.isErr()) {
    console.warn(`Failed to prune managed worktrees: ${cleanup.error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = cleanup.value;
  const preserved = result.removed.filter((entry) => entry.recoveryRef).length;
  console.log(`Pruned ${result.removed.length} stale managed worktree${result.removed.length === 1 ? "" : "s"}.`);
  if (preserved > 0) console.log(`Preserved ${preserved} recovery ref${preserved === 1 ? "" : "s"}.`);
  if (result.missing.length > 0) {
    console.log(`Cleared ${result.missing.length} missing worktree session${result.missing.length === 1 ? "" : "s"}.`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} worktree${result.skipped.length === 1 ? "" : "s"} with untracked files.`);
  }
  for (const failure of result.failed) {
    console.warn(`Failed to prune ${failure.workspaceId}: ${failure.error.message}`);
  }
  if (result.failed.length > 0) process.exitCode = 1;
}

function printHelp(): void {
  console.log(
    [
      "Synrex",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  synrex serve           Start the server",
      "  synrex init            Create or update ~/.devspace/config.jsonc and auth.json",
      "  synrex doctor          Show config, runtime, and native dependency status",
      "  synrex doctor --auth   Show OAuth state and new-client enrollment status",
      "  synrex oauth lock      Deny new OAuth clients and grants; keep existing tokens",
      "  synrex oauth window 10 Temporarily allow owner-authorized new connections (1-15 min)",
      "  synrex oauth status    Show current OAuth enrollment policy",
      "  synrex config get      Print persisted config",
      "  synrex config set publicBaseUrl <url|null>",
      "  synrex worktrees prune Prune managed worktrees unused for 3 days",
      "  synrex show-changes <review-ref> [--json]",
      "  synrex workflow list [--workspace <path>]  List resumable GPT coding workflows",
      "  synrex workflow show <workflow-id> [--workspace <path>]",
      "  synrex workflow create [--workspace <path>] < workflow.json",
      "  synrex workflow checkpoint <workflow-id> [--workspace <path>] < checkpoint.json",
      "  synrex diagnose [--minutes 30]  Inspect small, local, redacted MCP/tool timeline",
      "  synrex agents ls       List subagent sessions",
      "  synrex agents run <profile-or-provider|auto> [--model <model>] [--effort <level>] <prompt>",
      "  synrex agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  synrex agents show <id>",
      "  synrex agents daemon <status|stop|logs>",
      "  synrex nodes coordinator [--json]   Host the lightweight shared directory",
      "  synrex nodes connect <coordinator-url> --token <join-token> [--alias <name>] [--json]",
      "  synrex nodes gateway [--json]       Legacy alias for coordinator",
      "  synrex nodes join <gateway-url> --token <join-token> [--alias <name>] [--json]  Legacy alias",
      "  synrex nodes list [--json]",
      "  synrex nodes drain <node-id-or-alias>",
      "  synrex nodes undrain <node-id-or-alias>",
      "  synrex nodes alias <name>",
      "  synrex nodes pin <path-prefix> <node-id-or-alias> [--prefer]",
      "  synrex nodes pins [--json]",
      "  synrex nodes unpin <rule-id>",
      "  synrex nodes join-token",
      "  synrex -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  synrex config set publicBaseUrl https://example.trycloudflare.com",
      "  synrex serve",
    ].join("\n"),
  );
}

async function runNodesCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "coordinator":
      await configureGateway(commandArgs, json, "coordinator");
      return;
    case "gateway":
      await configureGateway(commandArgs, json, "gateway");
      return;
    case "connect":
      await joinGateway(commandArgs, json, "peer");
      return;
    case "join":
      await joinGateway(commandArgs, json, "worker");
      return;
    case "list":
    case "ls":
      listNodes(commandArgs, json);
      return;
    case "drain":
      setNodeDrain(commandArgs, true, json);
      return;
    case "undrain":
      setNodeDrain(commandArgs, false, json);
      return;
    case "alias":
      setLocalNodeAlias(commandArgs, json);
      return;
    case "pin":
      pinWorkspacePath(commandArgs, json);
      return;
    case "pins":
      listPlacementRules(commandArgs, json);
      return;
    case "unpin":
      unpinWorkspacePath(commandArgs, json);
      return;
    case "join-token":
      printJoinToken(commandArgs, json);
      return;
    default:
      throw new Error("Usage: synrex nodes <coordinator|connect|gateway|join|list|drain|undrain|alias|pin|pins|unpin|join-token> ...");
  }
}

async function configureGateway(args: string[], json: boolean, role: "gateway" | "coordinator"): Promise<void> {
  if (args.length > 0) throw new Error(`Usage: synrex nodes ${role} [--json]`);
  const files = loadDevspaceFiles();
  const joinToken = files.auth.nodeJoinToken ?? generateNodeJoinToken();
  writeDevspaceAuth({ ...files.auth, nodeJoinToken: joinToken });
  setDevspaceConfigValue(["cluster", "role"], role);
  const outputValue = {
    role,
    // Explicit join-token retrieval remains available via "nodes join-token".
    ...(role === "gateway" ? { joinToken } : {}),
    configPath: files.configPath,
    authPath: files.authPath,
  };
  if (json) {
    printJson(outputValue);
    return;
  }
  console.log(`Configured the ${role === "coordinator" ? "shared directory" : "legacy gateway"} on this complete Synrex runtime.`);
  if (role === "gateway") console.log(`Join token: ${joinToken}`);
  else console.log("Retrieve the join token explicitly with `synrex nodes join-token`.");
  console.log("Restart Synrex, then run `synrex nodes connect <coordinator-url> --token <join-token>` on another peer.");
}

async function joinGateway(args: string[], json: boolean, role: "worker" | "peer"): Promise<void> {
  const parsed = parseNodeJoinArgs(args);
  const gatewayUrl = normalizeGatewayUrl(parsed.gatewayUrl);
  const config = loadConfig();
  const store = new SqliteControlPlaneStore(config.stateDir);
  const semantic = new SerenaSemanticManager();
  try {
    const durable = new DurableTaskManager();
    const registration = localNodeRegistration(config, {
      semanticAvailable: semantic.available,
      durableTasksAvailable: durable.available,
    });
    if (parsed.alias) registration.alias = parsed.alias;
    const localNode = store.ensureLocalNode(registration);
    const response = await fetch(nodeApiUrl(gatewayUrl, "register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${parsed.token}`,
      },
      body: JSON.stringify({
        node: {
          id: localNode.id,
          alias: parsed.alias ?? localNode.alias,
          protocol: localNode.protocol,
          platform: localNode.platform,
          capabilities: localNode.capabilities,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gateway rejected node registration (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    const body = await response.json() as { nodeToken?: unknown };
    if (typeof body.nodeToken !== "string" || !body.nodeToken) {
      throw new Error("Gateway registration did not return a node token.");
    }

    const files = loadDevspaceFiles();
    writeDevspaceAuth({ ...files.auth, nodeToken: body.nodeToken });
    const edits = [
      { path: ["cluster", "role"], value: role },
      { path: ["cluster", "gatewayUrl"], value: gatewayUrl },
      ...(parsed.alias ? [{ path: ["node", "alias"], value: parsed.alias }] : []),
    ];
    setDevspaceConfigValues(edits);
    const outputValue = { nodeId: localNode.id, alias: parsed.alias ?? localNode.alias, gatewayUrl, role };
    if (json) printJson(outputValue);
    else {
      console.log(`Registered complete Synrex peer ${outputValue.alias ?? outputValue.nodeId} with the shared directory.`);
      console.log("Restart Synrex on this host to enable directory registration and remote dispatch.");
    }
  } finally {
    await semantic.close();
    store.close();
  }
}

function listNodes(args: string[], json: boolean): void {
  if (args.length > 0) throw new Error("Usage: devspace nodes list [--json]");
  const config = loadConfig();
  const store = new SqliteControlPlaneStore(config.stateDir);
  try {
    new NodeHealthMonitor(store, config.cluster.suspectAfterMs, config.cluster.offlineAfterMs).reconcile();
    const nodes = store.listNodes();
    if (json) {
      printJson({ nodes });
      return;
    }
    if (nodes.length === 0) {
      console.log("No execution nodes registered.");
      return;
    }
    const local = nodes.find((node) => node.kind === "local");
    const localBuild = local?.capabilities.runtime?.buildFingerprint;
    const localContracts = local?.capabilities.toolContracts;
    for (const node of nodes) {
      const label = node.alias ? `${node.alias} (${node.id})` : node.id;
      const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(node.lastSeenAt)) / 1000));
      const runtime = node.capabilities.runtime
        ? ` build=${node.capabilities.runtime.buildFingerprint.slice(0, 12)} version=${node.capabilities.runtime.version}`
          + (localBuild
            ? ` source=${node.capabilities.runtime.buildFingerprint === localBuild ? "same" : "different"}`
            : "")
        : " build=unknown";
      const comparison = compareToolContracts(localContracts, node.capabilities.toolContracts);
      const contracts = comparison.comparable
        ? ` contracts=${comparison.matching}/${comparison.total}`
          + (comparison.incompatible ? ` incompatible=${comparison.incompatible}` : "")
        : " contracts=unadvertised";
      console.log(`${label} ${node.kind} ${node.health} ${node.platform.os}/${node.platform.arch} seen=${ageSeconds}s features=${node.capabilities.features.length}${runtime}${contracts}`);
    }
  } finally {
    store.close();
  }
}

function setNodeDrain(args: string[], draining: boolean, json: boolean): void {
  const [selector, ...extra] = args;
  if (!selector || extra.length > 0) {
    throw new Error(`Usage: devspace nodes ${draining ? "drain" : "undrain"} <node-id-or-alias> [--json]`);
  }
  const config = loadConfig();
  const store = new SqliteControlPlaneStore(config.stateDir);
  try {
    const node = store.findNode(selector);
    if (!node) throw new Error(`Unknown execution node: ${selector}`);
    const updated = store.setNodeHealth(node.id, draining ? "draining" : "online");
    if (json) printJson(updated);
    else console.log(`${updated.alias ?? updated.id}: ${updated.health}`);
  } finally {
    store.close();
  }
}

function setLocalNodeAlias(args: string[], json: boolean): void {
  const [alias, ...extra] = args;
  if (!alias?.trim() || extra.length > 0) {
    throw new Error("Usage: devspace nodes alias <name> [--json]");
  }
  const normalized = alias.trim();
  setDevspaceConfigValue(["node", "alias"], normalized);
  if (json) printJson({ alias: normalized, restartRequired: true });
  else console.log(`Local node alias set to ${normalized}. Restart Synrex to publish it.`);
}

function pinWorkspacePath(args: string[], json: boolean): void {
  const prefer = args.includes("--prefer");
  const positional = args.filter((item) => item !== "--prefer");
  const [pathPrefix, selector, ...extra] = positional;
  if (!pathPrefix || !selector || extra.length > 0) {
    throw new Error("Usage: devspace nodes pin <path-prefix> <node-id-or-alias> [--prefer] [--json]");
  }
  const config = loadConfig();
  const store = new SqliteControlPlaneStore(config.stateDir);
  try {
    const node = store.findNode(selector);
    if (!node) throw new Error(`Unknown execution node: ${selector}`);
    const rule = {
      id: `pin_${Date.now().toString(36)}`,
      pathPrefix,
      mode: prefer ? "prefer" as const : "require" as const,
      node: node.id,
      labels: {},
    };
    setDevspaceConfigValue(["cluster", "placementRules"], [...config.cluster.placementRules, rule]);
    if (json) printJson(rule);
    else {
      console.log(`${rule.mode === "require" ? "Pinned" : "Preferred"} ${pathPrefix} -> ${node.alias ?? node.id} (${rule.id}).`);
      console.log("Restart Synrex to apply the placement rule.");
    }
  } finally {
    store.close();
  }
}

function listPlacementRules(args: string[], json: boolean): void {
  if (args.length > 0) throw new Error("Usage: devspace nodes pins [--json]");
  const rules = loadConfig().cluster.placementRules;
  if (json) {
    printJson({ rules });
    return;
  }
  if (rules.length === 0) {
    console.log("No workspace placement rules configured.");
    return;
  }
  for (const rule of rules) {
    const target = rule.node
      ? `node=${rule.node}`
      : `labels=${Object.entries(rule.labels).map(([key, value]) => `${key}=${value}`).join(",")}`;
    console.log(`${rule.id} ${rule.mode} ${rule.pathPrefix} -> ${target}`);
  }
}

function unpinWorkspacePath(args: string[], json: boolean): void {
  const [ruleId, ...extra] = args;
  if (!ruleId || extra.length > 0) throw new Error("Usage: devspace nodes unpin <rule-id> [--json]");
  const config = loadConfig();
  const next = config.cluster.placementRules.filter((rule) => rule.id !== ruleId);
  if (next.length === config.cluster.placementRules.length) {
    throw new Error(`Unknown placement rule: ${ruleId}`);
  }
  setDevspaceConfigValue(["cluster", "placementRules"], next);
  if (json) printJson({ removed: ruleId, restartRequired: true });
  else console.log(`Removed placement rule ${ruleId}. Restart Synrex to apply the change.`);
}

function printJoinToken(args: string[], json: boolean): void {
  if (args.length > 0) throw new Error("Usage: devspace nodes join-token [--json]");
  const files = loadDevspaceFiles();
  if (!files.auth.nodeJoinToken) throw new Error("No node join token exists. Run `devspace nodes gateway` first.");
  if (json) printJson({ joinToken: files.auth.nodeJoinToken });
  else console.log(files.auth.nodeJoinToken);
}

function parseNodeJoinArgs(args: string[]): { gatewayUrl: string; token: string; alias?: string } {
  const gatewayUrl = args[0];
  if (!gatewayUrl) throw new Error("Usage: devspace nodes join <gateway-url> --token <join-token> [--alias <name>] [--json]");
  let token: string | undefined;
  let alias: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--token") token = args[++index];
    else if (item === "--alias") alias = args[++index];
    else throw new Error(`Unknown nodes join option: ${item}`);
  }
  if (!token) throw new Error("nodes join requires --token <join-token>.");
  if (alias !== undefined && !alias.trim()) throw new Error("Node alias cannot be empty.");
  return { gatewayUrl, token, alias: alias?.trim() };
}

function normalizeGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Gateway URL must use HTTPS, or HTTP for localhost only.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return url.toString().replace(/\/$/, "");
}

async function runShowChanges(args: string[]): Promise<void> {
  const { args: commandArgs, json } = extractJsonOption(args);
  const [reviewRef, ...extra] = commandArgs;
  if (!reviewRef || extra.length > 0) {
    throw new Error("Usage: devspace show-changes <review-ref> [--json]");
  }

  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const review = await readReviewRef(scope.workspaceRoot, reviewRef);
  if (json) {
    printJson(review);
    return;
  }
  console.log(review.patch || review.result);
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList(commandArgs, json);
      return;
    case "run":
      await runAgentsRun(commandArgs, json);
      return;
    case "continue":
      await runAgentsContinue(commandArgs, json);
      return;
    case "show":
      await runAgentsShow(commandArgs, json);
      return;
    case "events":
      await runAgentsEvents(commandArgs, json);
      return;
    case "stats":
      await runAgentsStats(commandArgs, json);
      return;
    case "watch":
      await runAgentsWatch(commandArgs, json);
      return;
    case "targets":
      await runAgentsTargets(commandArgs, json);
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else console.log(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const summary of summaries) {
    console.log(formatAgentSummary(summary));
  }
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  let target = parsed.target;
  if (target === "auto") {
    const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
    );
    target = routeAutoAgent(
      parsed.prompt,
      buildLocalAgentCatalog(config.subagents, profiles, providers),
    ).target;
  }
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));
}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  let record = presentAgentResult(initial, json);
  if (!record) return;

  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    const refreshed = presentAgentResult(await client.get(id, scope), json);
    if (!refreshed) return;
    record = refreshed;
  }

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else console.log(formatAgentObservation(observation));
}

async function runAgentsEvents(args: string[], json: boolean): Promise<void> {
  const [id, afterRaw, ...extra] = args;
  if (!id || extra.length > 0 || (afterRaw !== undefined && !/^\d+$/.test(afterRaw))) {
    throw new Error("Usage: devspace agents events <id> [after-seq] [--json]");
  }
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const events = presentAgentResult(await client.events(
    id, resolveCliWorkspaceContext(config.allowedRoots), Number(afterRaw ?? 0), 200,
  ), json);
  if (!events) return;
  if (json) printJson(events);
  else for (const event of events) console.log(formatAgentEvent(event));
}

async function runAgentsStats(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents stats [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const stats = presentAgentResult(await client.stats(resolveCliWorkspaceContext(config.allowedRoots)), json);
  if (!stats) return;
  if (json) printJson(stats);
  else console.log(
    `Sessions: ${stats.sessions} (${stats.running} running, ${stats.completed} idle, ${stats.failed} failed)` +
    `\nTurns: ${stats.turns} (${stats.successfulTurns} completed, ${stats.failedTurns} failed)` +
    `\nRuntime: ${stats.durationMs}ms; input/output tokens: ${stats.inputTokens ?? "unreported"}/${stats.outputTokens ?? "unreported"}`,
  );
}

function formatAgentEvent(event: { seq: number; at: string; kind: string; label?: string; durationMs?: number }): string {
  return `${event.seq} ${event.at} ${event.kind}${event.label ? " " + event.label : ""}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}`;
}

/** Read-only near-real-time CLI tail. All events are persisted before publication. */
async function runAgentsWatch(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents watch <id> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  let afterSeq = 0;
  const deadline = Date.now() + 30 * 60_000;
  while (true) {
    const events = presentAgentResult(await client.events(id, scope, afterSeq, 200), json);
    if (!events) return;
    for (const event of events) {
      afterSeq = event.seq;
      if (json) printJson(event);
      else console.log(formatAgentEvent(event));
    }
    const agent = presentAgentResult(await client.get(id, scope), json);
    if (!agent) return;
    if (agent.status !== "running" && agent.status !== "starting" && events.length < 200) {
      // A terminal record may become visible a moment before its terminal event.
      await sleep(150);
      const finalEvents = presentAgentResult(await client.events(id, scope, afterSeq, 200), json);
      if (!finalEvents) return;
      for (const event of finalEvents) {
        afterSeq = event.seq;
        if (json) printJson(event);
        else console.log(formatAgentEvent(event));
      }
      return;
    }
    if (Date.now() > deadline) throw new Error("Agent watch window expired; execution was not cancelled.");
    await sleep(500);
  }
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: devspace agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "Synrex agents",
      "",
      "Usage:",
      "  devspace agents ls [--json]",
      "  devspace agents run <profile-or-provider|auto> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents events <id> [after-seq] [--json]",
      "  devspace agents watch <id> [--json]",
      "  devspace agents stats [--json]",
      "  devspace agents targets [--json]",
      "  devspace agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read Synrex package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `Synrex requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
