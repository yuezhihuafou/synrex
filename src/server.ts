import { registerOAuthRecovery } from "./oauth-recovery.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { startRuntimeSampler } from "./runtime-sampler.js";
import { requestTraceMiddleware, bodyReadyTrace } from "./http-trace.js";
import { traceEvent, traceStage, errorCategory } from "./trace-stages.js";
import { registerSynrexConsole } from "./console-router.js";
import { watchToolExecution } from "./tool-execution-watch.js";
import { hostsDirectory, joinsDirectory } from "./multinode/topology.js";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createOAuthMetadata, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  currentRequestLogContext,
  logEvent,
  requestIp,
  requestPath,
  runWithRequestLogContext,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { readBatch, validateBatchFiles } from "./batch-read.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  normalizeMcpToolCallArgumentAliases,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { DurableTaskManager } from "./durable-tasks.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  conversationScopeIdFromRequestMeta,
  conversationTitleFromRequestMeta,
  conversationTraceIdFromRequestMeta,
  safeConversationTitle,
} from "./request-meta.js";
import { CompletionMailbox, appendMailboxEvents, mailboxScope } from "./completion-mailbox.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { withCodingWorkflowStore } from "./coding-workflows.js";
import { registerCodingWorkflowTools } from "./coding-workflow-tools.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { SerenaSemanticManager } from "./serena-semantic.js";
import { localNodeRegistration } from "./multinode/local-node.js";
import { SqliteControlPlaneStore } from "./multinode/store.js";
import type { ExecutionNode } from "./multinode/protocol.js";
import { LearningStore } from "./learning-store.js";
import { ToolInvoker } from "./tool-invoker.js";
import { registerProjectIntelligenceTools } from "./project-intelligence-tools.js";
import { ArchitectureModelManager } from "./architecture-model.js";
import { registerGatewayNodeRoutes } from "./multinode/gateway-routes.js";
import { NodeHealthMonitor } from "./multinode/health.js";
import { NodeLinkHub } from "./multinode/link-hub.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import { withMultiNodeRouting } from "./multinode/mcp-routing.js";
import { MultiNodeRouter } from "./multinode/router.js";
import { NodeWorkerClient } from "./multinode/worker-client.js";
import {
  authorizationMetadataPath,
  normalizedPublicBasePath,
  publicEndpointUrl,
} from "./public-endpoints.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

function mcpServerInfo() {
  return {
    name: "synrex",
    title: "Synrex",
    version: DEVSPACE_VERSION,
    description:
      "Synrex is a self-hosted, GPT-first coding and execution harness. Read and edit project code, run builds and tests, inspect changes, resume durable tasks, and work across authorized hosts with project architecture safeguards. GPT leads reasoning; Synrex executes and records verifiable results.",
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  localNode: ExecutionNode;
  controlPlaneStore: SqliteControlPlaneStore;
  close(): Promise<void>;
}

type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();
  get activeCount(): number { return this.active.size; }

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user supplies or generates a file that is not present on the Synrex host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, and ${toolNames.read} permits files within advertised skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Use Synrex for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, selecting a different execution node, or when the current workspaceId is rejected.`;
  const placement = " In multi-node mode, normally omit the open_workspace node selector and let Synrex resolve placement. Never guess a node. Set node only when the user explicitly identifies a host or Synrex reports an ambiguity with candidate nodes; required placement rules cannot be overridden by the model.";
  const intelligence = " Use project for relevant architecture changes or verified local experience, not for repetitive approval of ordinary reads/edits. Do not run the same project check without new evidence.";
  const workflows = " For genuinely long or multi-session tasks, use workflow_open/checkpoint at meaningful handoff boundaries, not after each step. Batch independent reads, prefer task_wait to repeated task_get polling, and run focused tests during edits with final comprehensive checks before release. Keep GPT responsible for design and correctness; deterministic execution needs no repeated model confirmations. On recovery check current Git/tasks rather than trusting summaries. Synrex cannot resume GPT reasoning after a host turn ends.";

  return `${common}${placement} ${toolSurface.instructions({ agents, skills })}${intelligence}${workflows}${artifactInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Synrex Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  durableTasks?: DurableTaskManager,
  semantic?: SerenaSemanticManager,
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    mcpServerInfo(),
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );

  registerMcpSurface(
    server,
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    trackToolActivity,
    durableTasks,
    semantic,
  );
  return server;
}

function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  durableTasks?: DurableTaskManager,
  semantic?: SerenaSemanticManager,
): void {
  const learning = new LearningStore(config.stateDir);
  const registrationTarget = withTrackedToolHandlers(
    server,
    config,
    trackToolActivity,
    learning,
    workspaces,
    durableTasks,
  );
  const toolSurface = getToolSurface(config.toolMode);

  registerAppResource(
    registrationTarget,
    "Synrex Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing Synrex file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    registrationTarget,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a project checkout or isolated worktree. Reuse an existing workspaceId for continued work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute project path or ~/path within an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "checkout (default) or isolated Git worktree.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Worktree base Git ref; defaults to HEAD."),
        node: z
          .string()
          .optional()
          .describe("Explicit node alias/id, only when needed."),
        conversationTitle: z.string().max(120).optional()
          .describe("Optional actual chat title for diagnostics. Do not guess."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        pendingTasks: z.array(z.object({
          taskId: z.string(),
          status: z.enum(["completed", "cancelled", "failed"]),
        })).optional(),
        pendingTaskCount: z.number().int().nonnegative().optional(),
        activeTasks: z.array(z.object({
          taskId: z.string(), status: z.enum(["working", "input_required"]),
        })).optional(),
        activeTaskCount: z.number().int().nonnegative().optional(),
        resumableWorkflows: z.array(z.object({
          workflowId: z.string(),
          title: z.string(),
          status: z.enum(["active", "blocked"]),
          revision: z.number().int().nonnegative(),
          summary: z.string(),
        })).optional(),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const conversationScopeId = conversationScopeIdFromRequestMeta(_meta);
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId },
      );
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const allPendingTasks = durableTasks?.available
        ? await durableTasks.pendingNotifications(workspace.root)
        : [];
      const pendingTasks = allPendingTasks.slice(0, 8).map((task) => ({
        taskId: task.taskId,
        status: task.status,
      }));
      const allActiveTasks = durableTasks?.available
        ? await durableTasks.activeTaskHandles(workspace.root)
        : [];
      const resumableWorkflows = withCodingWorkflowStore(config.stateDir, (store) =>
        store.list(workspace.root, { limit: 5 }).map((workflow) => ({
          workflowId: workflow.workflowId,
          title: workflow.title,
          status: workflow.status as "active" | "blocked",
          revision: workflow.revision,
          summary: workflow.checkpoint.summary,
        })),
      );
      const preloadSubagents = config.subagents.enabled
        && config.subagents.instructions === "preload";
      const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
      const preloadedSubagentInstructions = preloadSubagents && subagentsSkill
        ? readFileSync(subagentsSkill.filePath, "utf8")
        : undefined;
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const dedupedAgents = includeBootstrapContext
        ? await workspaces.dedupeConversationAgentsFiles(conversationScopeId, workspace.root, agentsFiles)
        : { files: [], reusedPaths: [] };
      const loadedAgentsFiles = dedupedAgents.files.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const workspaceInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const instruction = preloadedSubagentInstructions && includeBootstrapContext
        ? [
            workspaceInstruction,
            "Subagent workflow instructions:",
            preloadedSubagentInstructions,
          ].join("\n\n")
        : workspaceInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            dedupedAgents.reusedPaths.length > 0
              ? `Unchanged workspace instructions already loaded in this conversation remain in force: ${dedupedAgents.reusedPaths.join(", ")}. If their text is not present in current context, read those paths before continuing.`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            pendingTasks.length > 0
              ? `Unacknowledged TERMINAL command receipts (${allPendingTasks.length} historical results, not active processes): ${pendingTasks.map((task) => `${task.taskId}=${task.status}`).join(", ")}. A completed command does not prove the user's objective is done. Use task_get or 'devspace-task get <taskId>' to inspect results. Unrelated receipts do not block this request.`
              : undefined,
            allActiveTasks.length > 0
              ? `Currently ACTIVE durable commands (${allActiveTasks.length}): ${allActiveTasks.slice(0, 8).map((task) => `${task.taskId}=${task.status}`).join(", ")}. Inspect these handles before retrying or cancelling work.`
              : undefined,
            resumableWorkflows.length > 0
              ? `Resumable coding workflows: ${resumableWorkflows.map((item) => `${item.workflowId}(${item.status},rev=${item.revision}): ${item.title}`).join("; ")}. Use workflow_open with workflowId to resume, and check actual code and test evidence.`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          review,
          ...(pendingTasks.length > 0 ? { pendingTasks, pendingTaskCount: allPendingTasks.length } : {}),
          ...(allActiveTasks.length > 0 ? { activeTasks: allActiveTasks.slice(0, 8), activeTaskCount: allActiveTasks.length } : {}),
          ...(resumableWorkflows.length > 0 ? { resumableWorkflows } : {}),
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  registrationTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description: "Read path or up to 8 file ranges via files, concurrently; full text and errors, not summaries. Read nested AGENTS and matching skills from open_workspace first. Advertised skill paths may be outside workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .optional()
          .describe(
            config.skillsEnabled ? "Workspace file or advertised skill path." : "Workspace file.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("1-500 lines; default 250."),
        files: z.array(z.object({
          path: z.string().min(1),
          offset: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })).min(1).max(8).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      if (input.files !== undefined) {
        if (input.path !== undefined || input.offset !== undefined || input.limit !== undefined) {
          throw new Error("Use read.path or read.files, not both.");
        }
        const response = await readBatch(validateBatchFiles(input.files), async (file) => {
          const readPath = workspaces.resolveReadPath(workspace, file.path);
          const result = await readFileTool({ ...file, path: readPath.absolutePath }, {
            cwd: workspace.root, root: workspace.root, readRoots: readPath.readRoots,
          });
          return { ...result, structuredContent: { result: contentText(result.content) } };
        });
        logToolCall(config, { tool: toolNames.read, workspaceId,
          success: response.structuredContent.errorCount === 0,
          durationMs: Math.round(performance.now() - startedAt) });
        return response;
      }
      if (typeof input.path !== "string" || !input.path.trim()) {
        throw new Error("read.path is required when read.files is not supplied.");
      }
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath, limit: input.limit ?? 250 },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerProjectIntelligenceTools({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
    durableTasks,
    semantic,
  }, learning);

  registerCodingWorkflowTools({
    server: registrationTarget,
    workspaces,
    stateDir: config.stateDir,
  });

  toolSurface.register({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
    durableTasks,
    semantic,
  });

  registerAppTool(
    registrationTarget,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const architecture = new ArchitectureModelManager({ semantic });
      let architectureErrors: Array<{ code: string; message: string }> = [];
      let architectureWarningCount = 0;
      if (await architecture.hasModel(workspace.root)) {
        const issues = await architecture.conformance(workspace.root);
        const errors = issues.filter((issue) => issue.severity === "error");
        architectureErrors = errors.map((issue) => ({
          code: issue.code,
          message: issue.message,
        }));
        architectureWarningCount = issues.filter((issue) => issue.severity === "warning").length;
      }
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: architectureErrors.length === 0,
          });

      const architectureSummary = architectureErrors.length > 0
        ? ` Architecture conformance failed with ${architectureErrors.length} error(s): ${architectureErrors.slice(0, 5).map((issue) => `${issue.code}: ${issue.message}`).join(" | ")}`
        : architectureWarningCount > 0
          ? ` Architecture conformance: ${architectureWarningCount} warning(s).`
          : "";
      const result = `${review.result}${architectureSummary}`;
      const content = [textBlock(result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        ...(architectureErrors.length > 0 ? { isError: true } : {}),
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(registrationTarget, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  config: ServerConfig,
  trackToolActivity: TrackToolActivity | undefined,
  learning: LearningStore,
  workspaces: WorkspaceRegistry,
  durableTasks?: DurableTaskManager,
): McpRegistrationTarget {
  const diagnostics = new DiagnosticTrace(config.stateDir);
  const mailbox = new CompletionMailbox(config.stateDir);
  return {
    registerTool: ((...args: unknown[]) => {
      const toolName = typeof args[0] === "string" ? args[0] : "unknown";
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        async (...handlerArgs: unknown[]) => {
          const suppliedInput = handlerArgs[0] as { workspaceId?: unknown } | undefined;
          const extra = handlerArgs[1] as { _meta?: unknown } | undefined;
          const conversationId = conversationTraceIdFromRequestMeta(extra?._meta);
          const explicitTitle = toolName === "open_workspace"
            ? safeConversationTitle((suppliedInput as { conversationTitle?: unknown } | undefined)?.conversationTitle)
            : undefined;
          const conversationTitle = explicitTitle ?? conversationTitleFromRequestMeta(extra?._meta);
          if (conversationId) {
            diagnostics.record("conversation_seen", {
              requestId: currentRequestLogContext()?.requestId, conversationId,
            });
          }
          if (conversationTitle) {
            diagnostics.record("conversation_labeled", {
              conversationId, conversationTitle,
              requestId: currentRequestLogContext()?.requestId,
            });
          }
          const watch = watchToolExecution({
            tool: toolName,
            workspaceId: typeof suppliedInput?.workspaceId === "string" ? suppliedInput.workspaceId : undefined,
            requestId: currentRequestLogContext()?.requestId,
            emit: (level, event, fields) => {
              const context = currentRequestLogContext();
              const taggedFields = { ...fields, conversationId, traceId: context?.traceId ?? context?.requestId, nodeRequestId: context?.nodeRequestId,
                otelTraceId: context?.otelTraceId, otelSpanId: context?.otelSpanId, otelParentSpanId: context?.otelParentSpanId };
              diagnostics.record(event, taggedFields);
              if (config.logging.toolCalls || level === "warn") {
                logEvent(config.logging, level, event, taggedFields);
              }
            },
          });
          const parent = currentRequestLogContext();
          return runWithRequestLogContext({
            ...parent, requestId: parent?.requestId ?? watch.callId, path: parent?.path ?? "local",
            traceId: parent?.traceId ?? parent?.requestId ?? watch.callId, callId: watch.callId,
            emitDiagnostic: parent?.emitDiagnostic ?? ((event, fields) => diagnostics.record(event, fields)),
          }, async () => {
          const operation = () => traceStage("tool_handler", () => Promise.resolve(handler(...handlerArgs)), { tool: toolName });
          try {
            const result = trackToolActivity
              ? await trackToolActivity(operation)
              : await operation();
            await traceStage("learning", () => recordLearningToolCall(
              learning,
              workspaces,
              toolName,
              handlerArgs,
              result,
            ));
            const delivered = await traceStage("mailbox", () => appendCompletionMailbox(
              mailbox, durableTasks, workspaces, toolName, handlerArgs, result,
            ));
            const content = delivered && typeof delivered === "object"
              ? (delivered as { structuredContent?: { taskId?: unknown; runId?: unknown; exitCode?: unknown; error_code?: unknown } }).structuredContent
              : undefined;
            const isToolError = delivered && typeof delivered === "object"
              && (delivered as { isError?: unknown }).isError === true;
            watch.finish(isToolError ? "error" : "ok", {
              taskId: typeof content?.taskId === "string" ? content.taskId : undefined,
              runId: typeof content?.runId === "string" ? content.runId : undefined,
              exitCode: typeof content?.exitCode === "number" ? content.exitCode : undefined,
              errorCategory: isToolError ? (typeof content?.exitCode === "number" ? "command_exit" : content?.error_code === "INVALID_ARGUMENT" ? "invalid_input" : "tool_error") : undefined,
            });
            return delivered;
          } catch (error) {
            await recordLearningToolCall(
              learning,
              workspaces,
              toolName,
              handlerArgs,
              undefined,
              error,
            );
            watch.finish("error", { errorCategory: errorCategory(error) });
            throw error;
          }
          });
        },
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

/** Mail is opportunistic: only next normal tool response, same workspace and
 * conversation scope, and only after checking the actual durable task state.
 * No new host API or background model invocation is required.
 */
async function appendCompletionMailbox(
  mailbox: CompletionMailbox,
  durableTasks: DurableTaskManager | undefined,
  workspaces: WorkspaceRegistry,
  toolName: string,
  handlerArgs: unknown[],
  result: unknown,
): Promise<unknown> {
  if (!durableTasks?.available || !result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const response = result as Record<string, unknown>;
  const input = handlerArgs[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const workspaceId = (input as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string") return result;
  const extra = handlerArgs[1] as { _meta?: Record<string, unknown> } | undefined;
  const scope = mailboxScope(conversationScopeIdFromRequestMeta(extra?._meta));
  const content = response.structuredContent;
  const fields = content && typeof content === "object" && !Array.isArray(content)
    ? content as Record<string, unknown> : undefined;
  try {
    if (toolName === "exec_command"
      && fields?.running === true && typeof fields.taskId === "string") {
      mailbox.register(workspaceId, scope, fields.taskId);
      traceEvent("mailbox_registered", { workspaceId, taskId: fields.taskId, runId: fields.runId });
    }
    const compat = toolName === "exec_command"
      ? String((input as { cmd?: unknown }).cmd ?? "").trim()
        .match(/^devspace-task\s+(get|final)\s+(task_(?:[0-9a-f]{16}|[0-9a-f-]{36}))$/i)
      : null;
    const inspectedTaskId = compat?.[2] ?? (input as { taskId?: unknown }).taskId;
    if ((toolName === "task_get" || toolName === "task_wait" || compat)
      && typeof inspectedTaskId === "string"
      && ["completed", "cancelled", "failed"].includes(String(fields?.status))) {
      mailbox.acknowledge(workspaceId, scope, inspectedTaskId);
      traceEvent("mailbox_acknowledged", { workspaceId, taskId: inspectedTaskId, runId: fields?.runId });
      return result;
    }
    if (response.isError === true) return result;
    if (toolName === "task_get" || toolName === "task_wait") return result;
    // Registry lookup also verifies ownership; a foreign/remote workspace
    // cannot inspect or leak a local task's result.
    const workspace = await workspaces.getWorkspace(workspaceId);
    const events = await mailbox.collect(workspaceId, scope, (taskId) =>
      durableTasks.get(workspace.root, taskId, { acknowledge: false }),
    );
    for (const event of events) traceEvent("mailbox_delivered", { workspaceId, taskId: event.taskId, runId: event.runId });
    return appendMailboxEvents(response, events);
  } catch (error) {
    traceEvent("mailbox_error", { workspaceId, errorCategory: errorCategory(error) });
    // A notification must never change, block, or fail the original tool.
    return result;
  }
}

async function recordLearningToolCall(
  learning: LearningStore,
  workspaces: WorkspaceRegistry,
  toolName: string,
  handlerArgs: unknown[],
  output?: unknown,
  error?: unknown,
): Promise<void> {
  if (toolName === "open_workspace" || toolName === "project") return;
  // Polling and inspecting stored evidence are meta-operations, not new
  // learning episodes. Recording these would recursively pollute recall and
  // bury the real engineering history behind the agent's own status checks.
  if (toolName === "exec_command") {
    const input = handlerArgs[0] as { cmd?: unknown } | undefined;
    const command = typeof input?.cmd === "string" ? input.cmd.trim() : "";
    if (/^devspace-project(?:\s|$)|^devspace-log(?:\s|$)|^devspace-task\s+(?:get|wait|final)\s+/i.test(command)) return;
  }
  if (
    toolName === "task_get"
    && output
    && typeof output === "object"
    && !Array.isArray(output)
    && (output as { structuredContent?: { unchanged?: unknown } }).structuredContent?.unchanged === true
  ) return;
  const input = handlerArgs[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const workspaceId = (input as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string") return;
  try {
    const workspace = await workspaces.getWorkspace(workspaceId);
    const extra = handlerArgs[1] as { _meta?: Record<string, unknown> } | undefined;
    learning.recordToolCall({
      workspaceRoot: workspace.root,
      conversationScopeId: conversationScopeIdFromRequestMeta(extra?._meta),
      tool: toolName,
      toolInput: input,
      toolOutput: output,
      error,
    });
  } catch (error) {
    // Learning is observational and must never change primary tool behavior.
    traceEvent("learning_error", { stage: "learning", errorCategory: errorCategory(error), tool: toolName });
  }
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = express();
  const diagnostics = new DiagnosticTrace(config.stateDir);
  app.use(requestTraceMiddleware(config, diagnostics, requestLogFields));
  app.use(createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  }));
  app.use(bodyReadyTrace);
  diagnostics.record("runtime_started");
  registerOAuthRecovery(app, config);
  const publicBasePath = normalizedPublicBasePath(config.publicBaseUrl);
  const mcpRoute = `${publicBasePath}/mcp` || "/mcp";
  const assetRoute = `${publicBasePath}/mcp-app-assets` || "/mcp-app-assets";
  const healthRoute = `${publicBasePath}/healthz` || "/healthz";
  const mcpUrl = publicEndpointUrl(config.publicBaseUrl, "/mcp");
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir,
    (phase, reason) => {
      const context = currentRequestLogContext();
      logEvent(config.logging, "warn", "oauth_rejected", {
        phase,
        reason,
        requestId: context?.requestId,
        path: context?.path,
      });
    });
  logEvent(config.logging, "info", "oauth_state_ready", {
    stateDir: config.stateDir,
    issuer: config.publicBaseUrl,
    resource: mcpUrl.href,
  });
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const durableTasks = new DurableTaskManager();
  const semantic = new SerenaSemanticManager();
  const controlPlaneStore = new SqliteControlPlaneStore(config.stateDir);
  const localNode = controlPlaneStore.ensureLocalNode(localNodeRegistration(config, {
    semanticAvailable: semantic.available,
    durableTasksAvailable: durableTasks.available,
  }));
  const toolActivities = new ToolActivityTracker();
  const stopRuntimeSampler = startRuntimeSampler(diagnostics, () => toolActivities.activeCount);
  const linkHub = hostsDirectory(config.cluster.role)
    ? new NodeLinkHub(config.cluster.requestTimeoutMs, undefined, (event, fields) => {
        diagnostics.record(event, fields);
        logEvent(config.logging, event === "node_request_timeout" || event === "node_late_completion" ? "warn" : "info", event, fields);
      })
    : undefined;
  if (hostsDirectory(config.cluster.role) && !config.cluster.joinToken) {
    throw new Error("Coordinator mode requires a node join token. Run `devspace nodes coordinator` first.");
  }
  const nodeRouter = linkHub
    ? new MultiNodeRouter(controlPlaneStore, linkHub, localNode.id,
      (event, fields) => logEvent(config.logging, "info", event, fields))
    : undefined;
  const healthMonitor = linkHub
    ? new NodeHealthMonitor(controlPlaneStore, config.cluster.suspectAfterMs, config.cluster.offlineAfterMs)
    : undefined;
  if (linkHub && config.cluster.joinToken) {
    registerGatewayNodeRoutes(app, {
      joinToken: config.cluster.joinToken,
      pollWaitMs: config.cluster.pollWaitMs,
      store: controlPlaneStore,
      hub: linkHub,
    });
    healthMonitor?.start();
  }
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const modernToolSurface = getToolSurface(config.toolMode);
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    registerMcpSurface(
      target,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      toolActivities.track,
      durableTasks,
      semantic,
    );
  });
  const toolInvoker = new ToolInvoker();
  bindModernMcpSurface(toolInvoker.registrationTarget);
  localNode.capabilities.toolContracts = Object.fromEntries(
    toolInvoker.registeredToolNames().map((name) => [name, 1]),
  );
  controlPlaneStore.ensureLocalNode({
    id: localNode.id,
    alias: localNode.alias,
    protocol: localNode.protocol,
    platform: localNode.platform,
    capabilities: localNode.capabilities,
  });
  let nodeWorker: NodeWorkerClient | undefined;
  if (joinsDirectory(config.cluster.role)) {
    if (!config.cluster.gatewayUrl || !config.cluster.nodeToken) {
      throw new Error("Peer mode requires cluster.gatewayUrl and a node token. Run `devspace nodes connect <coordinator-url> --token <join-token>` first.");
    }
    nodeWorker = new NodeWorkerClient({
      gatewayUrl: config.cluster.gatewayUrl,
      gatewayFallbackUrl: config.cluster.gatewayFallbackUrl,
      node: localNode,
      nodeToken: config.cluster.nodeToken,
      pollWaitMs: config.cluster.pollWaitMs,
      heartbeatMs: config.cluster.heartbeatMs,
      invoker: toolInvoker,
      stateDir: config.stateDir,
      maxConcurrentCalls: 4,
      onDiagnostic: (event, fields) => diagnostics.record(event, fields),
      onMetric: (event, fields) => logEvent(config.logging, "info", event, fields),
    });
    nodeWorker.start();
  }
  const logMcpHandlerError = (error: Error) => {
    diagnostics.record("mcp_failed", { requestId: currentRequestLogContext()?.requestId });
    logEvent(config.logging, "error", "mcp_handler_error", modernMcpAdapterErrorLogFields(error));
  };
  const mcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: serverInstructions(config, modernToolSurface) },
    );
    const target = nodeRouter
      ? withMultiNodeRouting(adapter.registrationTarget, {
          router: nodeRouter,
          store: controlPlaneStore,
          localNodeId: localNode.id,
          placementRules: config.cluster.placementRules,
        })
      : adapter.registrationTarget;
    bindModernMcpSurface(target);
    return adapter.server;
  }, {
    legacy: "stateless",
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = toNodeHandler(mcpHandler, {
    onerror: logMcpHandlerError,
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", "loopback");
  }


    registerSynrexConsole(app, config);

  const oauthRouterOptions = {
    provider: oauthProvider,
    issuerUrl: new URL(config.publicBaseUrl),
    baseUrl: new URL(config.publicBaseUrl),
    resourceServerUrl,
    scopesSupported: config.oauth.scopes,
    resourceName: "Synrex",
  };
  const generatedOAuthMetadata = createOAuthMetadata(oauthRouterOptions);
  const publicOAuthMetadata = {
    ...generatedOAuthMetadata,
    authorization_endpoint: publicEndpointUrl(config.publicBaseUrl, "/authorize").href,
    token_endpoint: publicEndpointUrl(config.publicBaseUrl, "/token").href,
    registration_endpoint: generatedOAuthMetadata.registration_endpoint
      ? publicEndpointUrl(config.publicBaseUrl, "/register").href
      : undefined,
    revocation_endpoint: generatedOAuthMetadata.revocation_endpoint
      ? publicEndpointUrl(config.publicBaseUrl, "/revoke").href
      : undefined,
  };
  if (publicBasePath) {
    app.get(authorizationMetadataPath(config.publicBaseUrl), (_req, res) => {
      res.json(publicOAuthMetadata);
    });
    app.get(new URL(getOAuthProtectedResourceMetadataUrl(resourceServerUrl)).pathname, (_req, res) => {
      res.json({
        resource: resourceServerUrl.href,
        authorization_servers: [publicOAuthMetadata.issuer],
        scopes_supported: config.oauth.scopes,
        resource_name: "Synrex",
      });
    });
  }
  app.use(publicBasePath || "/", mcpAuthRouter(oauthRouterOptions));

  app.options(`${assetRoute}/{*asset}`, (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    assetRoute,
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get(healthRoute, (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all(mcpRoute, async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    try {
      const authStarted = performance.now();
      traceEvent("stage_started", { stage: "auth" });
      await new Promise<void>((resolve, reject) => {
        const finished = () => resolve();
        res.once("finish", finished);
        bearerAuth(req, res, (error?: unknown) => {
          res.off("finish", finished);
          if (error) reject(error);
          else resolve();
        });
      });
      traceEvent("stage_finished", { stage: "auth", outcome: res.statusCode >= 400 ? "error" : "ok", status: res.statusCode,
        durationMs: Math.round(performance.now() - authStarted), errorCategory: res.statusCode >= 400 ? "auth" : undefined });
      if (res.headersSent) return;

      if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "invalid_oauth_resource",
          ...requestLogFields(req, config),
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }

      logEvent(config.logging, "debug", "mcp_request", {
        requestId,
        method: req.method,
      });
      const mcpBody = normalizeMcpToolCallArgumentAliases(req.body);
      await traceStage("mcp_dispatch", () => mcpNodeHandler(req, res, mcpBody));
      diagnostics.record("mcp_handler_returned", { requestId, method: req.method });
    } catch (error) {
      diagnostics.record("mcp_failed", { requestId, traceId: requestId, errorCategory: errorCategory(error) });
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else if (!res.writableEnded && !res.destroyed) {
        // An adapter error after response headers cannot be repaired with a
        // second JSON-RPC payload. Terminate that broken response explicitly;
        // never leave a failed POST hanging until the client gives up.
        res.destroy();
      }
    }
  });

  // The SDK parser runs before /mcp. Record parser/size failures without
  // Express' default error page/log echoing pieces of the request body.
  app.use((error: unknown, req: Request, res: Response, next: express.NextFunction) => {
    if (requestPath(req) !== mcpRoute) return next(error);
    const status = (error as { status?: number })?.status === 413 ? 413 : 400;
    traceEvent("mcp_failed", { errorCategory: "protocol", status });
    if (!res.headersSent) sendJsonRpcError(res, status, -32700, "Invalid MCP request");
    else res.destroy();
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    localNode,
    controlPlaneStore,
    close: () => {
      closePromise ??= (async () => {
        diagnostics.record("runtime_stopping");
        stopRuntimeSampler();
        try {
          await mcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await toolActivities.waitForIdle();
        await nodeWorker?.close();
        healthMonitor?.stop();
        linkHub?.close();
        processSessions.shutdown();
        await semantic.close();
        controlPlaneStore.close();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders, localNode } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}${publicEndpointUrl(config.publicBaseUrl, "/mcp").pathname}`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    console.log(`node: ${localNode.alias ? `${localNode.alias} (${localNode.id})` : localNode.id}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close, 5_000, 12_000, (phase) => {
      logEvent(config.logging, "warn", "shutdown_forced", { phase });
    });
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
