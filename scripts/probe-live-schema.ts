import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteOAuthStore } from "../src/oauth-store.js";
import { getOAuthEnrollmentStatus } from "../src/oauth-enrollment.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { createReviewCheckpointManager } from "../src/review-checkpoints.js";
import { ProcessSessionManager } from "../src/process-sessions.js";
import { SerenaSemanticManager } from "../src/serena-semantic.js";
import { SqliteWorkspaceStore } from "../src/workspace-store.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { expectedToolNames, toolSchemaFingerprint } from "../src/tool-surface-manifest.js";

interface ProbeClient {
  client_id: string;
}

interface ProbeTokens {
  access_token: string;
  refresh_token?: string;
}

const config = loadConfig();
const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
const localBaseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
const redirectUri = "http://127.0.0.1/devspace-live-schema-probe";
const resource = new URL("/mcp", config.publicBaseUrl).href;
const verifier = "devspace-live-schema-probe-verifier-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");

// A locked production OAuth service must not create synthetic clients or
// tokens merely to check deployment. Authentication with an existing bearer
// must be verified by the real MCP host afterwards.
if (getOAuthEnrollmentStatus(config.stateDir).locked) {
  await waitForHealth(localBaseUrl);
  const [discovery, challengeResponse] = await Promise.all([
    fetch(`${localBaseUrl}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${localBaseUrl}/mcp`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  if (!discovery.ok) throw new Error(`Live OAuth discovery failed: HTTP ${discovery.status}`);
  if (challengeResponse.status !== 401 || !challengeResponse.headers.get("www-authenticate")) {
    throw new Error(`Live OAuth challenge failed: HTTP ${challengeResponse.status}`);
  }
  const metadata = await discovery.json() as { issuer?: unknown; authorization_endpoint?: unknown };
  const issuerMatches = typeof metadata.issuer === "string"
    && new URL(metadata.issuer).href === new URL(config.publicBaseUrl).href;
  if (!issuerMatches || typeof metadata.authorization_endpoint !== "string") {
    throw new Error("Live OAuth discovery metadata does not match configured issuer");
  }
  const tools = await compiledToolSurface();
  const names = tools.flatMap((tool) => (
    tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [(tool as { name: string }).name]
      : []
  )).sort();
  const expected = expectedToolNames(config.toolMode);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`Compiled tool surface does not match configured mode: ${config.toolMode}`);
  }
  console.log(JSON.stringify({
    ok: true,
    verification: "locked-http-and-compiled-schema",
    liveAuthenticatedToolListVerified: false,
    toolMode: config.toolMode,
    toolCount: names.length,
    schemaFingerprint: toolSchemaFingerprint(tools),
  }));
  process.exit(0);
}

let clientId: string | undefined;
let tokens: ProbeTokens | undefined;
try {
  await waitForHealth(localBaseUrl);

  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace live schema probe",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (registration.status !== 201) {
    throw new Error(`OAuth client registration failed: HTTP ${registration.status}: ${await registration.text()}`);
  }
  const client = await registration.json() as ProbeClient;
  clientId = client.client_id;
  if (!clientId) throw new Error("OAuth registration did not return client_id.");

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: config.oauth.scopes.join(" "),
      resource,
      state: "live-schema-probe",
      owner_token: config.oauth.ownerToken,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (approval.status !== 302) {
    throw new Error(`OAuth approval failed: HTTP ${approval.status}: ${await approval.text()}`);
  }
  const location = approval.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (!code) throw new Error("OAuth approval did not return an authorization code.");

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!exchange.ok) throw new Error(`OAuth token exchange failed: HTTP ${exchange.status}: ${await exchange.text()}`);
  tokens = await exchange.json() as ProbeTokens;
  if (!tokens.access_token) throw new Error("OAuth token exchange did not return an access token.");

  const response = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "devspace-live-schema-probe",
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "devspace-live-schema-probe", version: "1" },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`MCP tools/list failed: HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { result?: { tools?: unknown[] }; error?: unknown };
  if (!Array.isArray(payload.result?.tools)) {
    throw new Error(`MCP tools/list returned no tools: ${JSON.stringify(payload.error ?? payload)}`);
  }
  const tools = payload.result.tools;
  const names = tools.flatMap((tool) => (
    tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [(tool as { name: string }).name]
      : []
  )).sort();
  const expected = expectedToolNames(config.toolMode);
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Live MCP schema mismatch. missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`);
  }
  const liveFingerprint = toolSchemaFingerprint(tools);
  const expectedTools = await compiledToolSurface();
  const expectedFingerprint = toolSchemaFingerprint(expectedTools);
  if (liveFingerprint !== expectedFingerprint) {
    const expectedByName = new Map(expectedTools.flatMap((tool) => (
      tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
        ? [[(tool as { name: string }).name, tool] as const]
        : []
    )));
    const mismatched = tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return [];
      const name = (tool as { name: string }).name;
      const expectedTool = expectedByName.get(name);
      return expectedTool && toolSchemaFingerprint([tool]) !== toolSchemaFingerprint([expectedTool]) ? [name] : [];
    });
    const diffFields = (left: unknown, right: unknown, prefix = ""): string[] => {
      if (JSON.stringify(left) === JSON.stringify(right)) return [];
      if (!left || !right || typeof left !== "object" || typeof right !== "object") {
        return [prefix || "root"];
      }
      const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .flatMap((key) => diffFields(a[key], b[key], `${prefix}.${key}`));
    };
    const details = process.env.DEVSPACE_SCHEMA_DEBUG === "1"
      ? mismatched.map((name) => ({ name, paths: diffFields(
        tools.find((tool) => (tool as { name?: string }).name === name), expectedByName.get(name),
      ).slice(0, 50) }))
      : undefined;
    throw new Error(`Live MCP schema fingerprint mismatch. live=${liveFingerprint} compiled=${expectedFingerprint} tools=[${mismatched.join(", ")}]`
      + (details ? ` details=${JSON.stringify(details).slice(0, 12000)}` : ""));
  }

  let qaWorkflowId: string | undefined;
  let qaDurableTaskRecovered = false;
  let qaMailboxDelivered = false;
  let qaFinalBarrierVerified = false;
  if (process.env.DEVSPACE_QA_WORKFLOW_PROBE === "1") {
    if (!config.stateDir.includes("/devspace-reliable-qa-")) {
      throw new Error("Refusing mutating workflow smoke test outside disposable QA state");
    }
    let callId = 0;
    const callFull = async (
      name: string,
      arguments_: Record<string, unknown>,
      conversationScope?: string,
    ): Promise<{ structuredContent: Record<string, unknown>; content?: unknown }> => {
      const response = await fetch(`${localBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens!.access_token}`,
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": name,
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: ++callId, method: "tools/call",
          params: {
            name, arguments: arguments_,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "devspace-reliable-qa", version: "1" },
              ...(conversationScope ? { "openai/session": conversationScope } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`QA tool ${name} HTTP ${response.status}: ${(await response.text()).slice(0, 1200)}`);
      const data = await response.json() as {
        error?: unknown;
        result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown };
      };
      if (data.error || data.result?.isError || !data.result?.structuredContent) {
        throw new Error(`QA tool ${name} failed: ${JSON.stringify(data).slice(0, 1500)}`);
      }
      return data.result as { structuredContent: Record<string, unknown>; content?: unknown };
    };
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await callFull(name, args)).structuredContent;
    const first = await call("open_workspace", { path: process.cwd() });
    const firstWorkspace = first.workspaceId as string;
    if (!firstWorkspace) throw new Error("QA open_workspace returned no workspace ID");
    const resumeId = process.env.DEVSPACE_QA_WORKFLOW_RESUME_ID;
    if (resumeId) {
      const result = await call("workflow_status", { workspaceId: firstWorkspace, workflowId: resumeId });
      const workflow = result.workflow as {
        workflowId?: string; revision?: number; checkpoint?: { taskIds?: string[] };
      } | undefined;
      if (workflow?.workflowId !== resumeId || workflow.revision !== 1) {
        throw new Error("QA workflow did not survive a full Rev server restart");
      }
      const taskId = workflow.checkpoint?.taskIds?.[0];
      if (!taskId) throw new Error("QA checkpoint lost the pending durable task ID");
      let completed = false;
      let revision: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const task = await call("task_wait", { workspaceId: firstWorkspace, taskId,
          ...(revision ? { sinceRevision: revision } : {}) });
        if (task.status === "completed") {
          if (task.isError || task.exitCode !== 0) throw new Error("QA durable command failed after service restart");
          completed = true;
          break;
        }
        if (typeof task.revision === "string") revision = task.revision;
      }
      if (!completed) throw new Error("QA durable command did not complete after service restart");
      const closed = await call("workflow_checkpoint", {
        workspaceId: firstWorkspace, workflowId: resumeId, expectedRevision: 1,
        status: "completed", phase: "verified", summary: "Durable work completed through restart",
        completedSteps: ["MCP create and replay", "Durable command survived service restart"],
        nextSteps: [], blockers: [], checks: ["Recovered task_wait exitCode 0"], taskIds: [],
      });
      if (closed.revision !== 2) throw new Error("QA workflow could not finish after recovery");
      qaDurableTaskRecovered = true;
      qaWorkflowId = resumeId;
    } else {
      // Verify the actual HTTP tool result, not just the in-memory adapter:
      // opportunistic mailbox content must preserve the original structured
      // result and appear only for the conversation that launched the job.
      const sessionA = `mailbox-qa-${randomUUID()}`;
      const sessionB = `other-qa-${randomUUID()}`;
      const mailboxStart = await callFull("exec_command", {
        workspaceId: firstWorkspace,
        cmd: "sleep 3; printf 'MAILBOX_QA_COMPLETE\\n'",
      }, sessionA);
      const mailboxTaskId = mailboxStart.structuredContent.taskId;
      if (typeof mailboxTaskId !== "string") {
        throw new Error("QA mailbox command did not detach");
      }
      await new Promise((resolve) => setTimeout(resolve, 3_300));
      const unrelated = await callFull("read", { workspaceId: firstWorkspace, path: "package.json" }, sessionB);
      if (JSON.stringify(unrelated.content ?? []).includes("[Synrex Completion Mailbox]")) {
        throw new Error("QA mailbox leaked across conversation scope");
      }
      const related = await callFull("read", { workspaceId: firstWorkspace, path: "package.json" }, sessionA);
      if (!JSON.stringify(related.content ?? []).includes(`task=${mailboxTaskId} status=completed`)) {
        throw new Error("QA mailbox completion did not accompany normal read output");
      }
      const repeatedRead = await callFull("read", { workspaceId: firstWorkspace, path: "package.json" }, sessionA);
      if (JSON.stringify(repeatedRead.content ?? []).includes("[Synrex Completion Mailbox]")) {
        throw new Error("QA mailbox repeated a fresh notification");
      }
      if (typeof related.structuredContent.result !== "string" || !related.structuredContent.result.includes(`task=${mailboxTaskId} status=completed`)
        || typeof related.structuredContent.sourceResult !== "string" || !related.structuredContent.sourceResult.includes('"name": "synrex"')) {
        throw new Error("QA mailbox changed the original read structuredContent");
      }
      qaMailboxDelivered = true;
      const final = await callFull("exec_command", {
        workspaceId: firstWorkspace,
        cmd: `devspace-task final ${mailboxTaskId}`,
      }, sessionA);
      const finalBarrier = final.structuredContent.finalBarrier as { stage?: unknown } | undefined;
      if (finalBarrier?.stage !== "terminal") {
        throw new Error("QA final barrier did not return a terminal receipt");
      }
      qaFinalBarrierVerified = true;

      const args = {
        workspaceId: firstWorkspace, title: "QA persistent workflow",
        goal: "Verify a real HTTP MCP workflow and recover after restart",
        acceptanceCriteria: ["Revision survives restart"],
        constraints: ["Do not modify production"], requestKey: `qa:${randomUUID()}`,
      };
      const created = await call("workflow_open", args);
      const repeated = await call("workflow_open", args);
      if (created.workflowId !== repeated.workflowId) throw new Error("QA duplicate create was not deduplicated");
      qaWorkflowId = created.workflowId as string;
      const running = await call("exec_command", {
        workspaceId: firstWorkspace,
        cmd: "sleep 8; printf 'REV_QA_DURABLE_OK\\n'",
      });
      const taskId = running.taskId as string | undefined;
      if (!taskId || !/^task_[a-zA-Z0-9-]+$/.test(taskId)) {
        throw new Error("QA long command did not return a durable task handle");
      }
      const checkpoint = {
        workspaceId: firstWorkspace, workflowId: qaWorkflowId, expectedRevision: 0,
        status: "active", phase: "QA", summary: "Service restart expected",
        completedSteps: ["MCP open and idempotent create"], nextSteps: ["Restart and resume"],
        blockers: [], checks: ["HTTP MCP tools/call: succeeded"], taskIds: [taskId],
      };
      const saved = await call("workflow_checkpoint", checkpoint);
      const replay = await call("workflow_checkpoint", checkpoint);
      if (saved.revision !== 1 || replay.revision !== 1) {
        throw new Error("QA repeated checkpoint changed the committed revision");
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    localBaseUrl,
    toolMode: config.toolMode,
    toolCount: names.length,
    schemaFingerprint: liveFingerprint,
    tools: names,
    ...(qaWorkflowId ? { qaWorkflowId } : {}),
    ...(qaDurableTaskRecovered ? { qaDurableTaskRecovered } : {}),
    ...(qaMailboxDelivered ? { qaMailboxDelivered } : {}),
    ...(qaFinalBarrierVerified ? { qaFinalBarrierVerified } : {}),
  }));
} finally {
  if (clientId) {
    const store = new SqliteOAuthStore(config.stateDir);
    try {
      store.deleteClient(clientId);
    } finally {
      store.close();
    }
  }
}

async function compiledToolSurface(): Promise<unknown[]> {
  const root = await mkdtemp(join(tmpdir(), "devspace-schema-probe-"));
  const stateDir = join(root, "state");
  const probeConfig = {
    ...config,
    stateDir,
    worktreeRoot: join(root, "worktrees"),
    uiEnabled: false,
    artifactsEnabled: false,
  };
  const store = new SqliteWorkspaceStore(stateDir);
  const semantic = new SerenaSemanticManager({ available: false });
  const processSessions = new ProcessSessionManager({ runRoot: join(root, "runs") });
  const server = createMcpServer(
    probeConfig,
    new WorkspaceRegistry(probeConfig, store),
    createReviewCheckpointManager(),
    processSessions,
    () => [],
    [],
    undefined,
    undefined,
    semantic,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-compiled-schema-probe", version: "1" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.listTools();
    return listed.tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    processSessions.shutdown();
    await semantic.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok) return;
      lastError = new Error(`healthz returned HTTP ${health.status}: ${await health.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error
    ? new Error(`DevSpace did not become ready: ${lastError.message}`)
    : new Error("DevSpace did not become ready.");
}
