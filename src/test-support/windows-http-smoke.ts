import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStoreRoot } from "../compact-runtime/run-store.js";
import { publicEndpointUrl } from "../public-endpoints.js";

interface ToolDescription {
  name?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpResponse<T = Record<string, unknown>> {
  result?: T;
  error?: { code?: number; message?: string };
}

const [baseUrl, configDir, workspacePath] = process.argv.slice(2);
if (!baseUrl || !configDir || !workspacePath) {
  throw new Error("usage: windows-http-smoke <base-url> <config-dir> <workspace-path>");
}
if (process.platform !== "win32") process.exit(0);

const auth = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")) as {
  ownerToken?: string;
};
if (!auth.ownerToken) throw new Error("isolated auth owner token is missing");

const redirectUri = "http://127.0.0.1/callback";
const resource = publicEndpointUrl(baseUrl, "/mcp").href;
const verifier = "synrex-windows-http-smoke-verifier-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");

const registration = await fetch(publicEndpointUrl(baseUrl, "/register"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Synrex Windows acceptance smoke",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
if (registration.status !== 201) {
  throw new Error(`registration failed: ${registration.status} ${await registration.text()}`);
}
const client = await registration.json() as { client_id?: string };
if (!client.client_id) throw new Error("registration did not return client_id");

const approval = await fetch(publicEndpointUrl(baseUrl, "/authorize"), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource,
    state: "windows-smoke",
    owner_token: auth.ownerToken,
  }),
  redirect: "manual",
});
if (approval.status !== 302) {
  throw new Error(`authorization failed: ${approval.status} ${await approval.text()}`);
}
const location = approval.headers.get("location");
const code = location ? new URL(location).searchParams.get("code") : null;
if (!code) throw new Error("authorization did not return a code");

const exchange = await fetch(publicEndpointUrl(baseUrl, "/token"), {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource,
  }),
});
if (exchange.status !== 200) {
  throw new Error(`token exchange failed: ${exchange.status} ${await exchange.text()}`);
}
const token = (await exchange.json() as { access_token?: string }).access_token;
if (!token) throw new Error("token exchange did not return an access token");

async function postMcp<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<McpResponse<T>> {
  const name = typeof params.name === "string" ? params.name : undefined;
  const response = await fetch(publicEndpointUrl(baseUrl, "/mcp"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `windows-smoke-${method}-${Date.now()}`,
      method,
      params: {
        ...params,
        _meta: {
          ...(isRecord(params._meta) ? params._meta : {}),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "synrex-windows-http-smoke",
            version: "1.0.0",
          },
        },
      },
    }),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`${method} failed: ${response.status} ${text}`);
  }
  const parsed = JSON.parse(text) as McpResponse<T>;
  if (parsed.error) throw new Error(`${method} MCP error: ${JSON.stringify(parsed.error)}`);
  return parsed;
}

const discovery = await postMcp<{ supportedVersions?: string[] }>("server/discover");
if (!discovery.result?.supportedVersions?.includes("2026-07-28")) {
  throw new Error("candidate did not advertise the expected MCP protocol");
}

const listed = await postMcp<{ tools?: ToolDescription[] }>("tools/list");
const tools = listed.result?.tools ?? [];
const toolNames = tools.flatMap((tool) => tool.name ? [tool.name] : []);
const required = ["open_workspace", "exec_command", "write_stdin"];
for (const name of required) {
  if (!toolNames.includes(name)) throw new Error(`candidate tool surface is missing ${name}`);
}

const opened = await callTool("open_workspace", {
  path: workspacePath,
}, "windows-http-smoke");
const workspaceId = recordValue(opened.structuredContent).workspaceId;
if (typeof workspaceId !== "string") throw new Error("open_workspace did not return workspaceId");

const command = await callTool("exec_command", {
  workspace_id: workspaceId,
  working_directory: ".",
  cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('candidate-command-ok\\n')")}`,
});
const commandResult = recordValue(command.structuredContent);
if (
  commandResult.exitCode !== 0
  || !String(commandResult.result ?? commandResult.output ?? "").includes("candidate-command-ok")
) {
  throw new Error(`candidate command smoke failed: ${JSON.stringify(commandResult)}`);
}

const ptyStarted = await callTool("exec_command", {
  workspaceId,
  tty: true,
  columns: 80,
  rows: 24,
  cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('columns:' + process.stdout.columns), 4000)")}`,
});
let ptyResult = recordValue(ptyStarted.structuredContent);
const sessionId = ptyResult.sessionId;
if (typeof sessionId !== "number" || ptyResult.running !== true) {
  throw new Error(`candidate PTY did not return a running session: ${JSON.stringify(ptyResult)}`);
}
for (let attempt = 0; attempt < 30 && ptyResult.running === true; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 50 : 100));
  const polled = await callTool("write_stdin", {
    workspace_id: workspaceId,
    session_id: sessionId,
    chars: "",
    ...(attempt === 0 ? { columns: 120, rows: 30 } : {}),
  });
  ptyResult = recordValue(polled.structuredContent);
}
if (
  ptyResult.running === true
  || ptyResult.exitCode !== 0
) {
  throw new Error(`candidate PTY resize smoke failed: ${JSON.stringify(ptyResult)}`);
}
const ptyRunId = ptyResult.runId;
if (typeof ptyRunId !== "string") throw new Error("candidate PTY result is missing runId");
const ptyOutput = await readRunOutput(ptyRunId);
if (!ptyOutput.includes("columns:120")) {
  throw new Error(`candidate PTY resize was not reflected in run output: ${JSON.stringify(ptyOutput)}`);
}

const durableStarted = await callTool("exec_command", {
  workspaceId,
  cmd: "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2; Write-Output 'candidate-durable-ok'\"",
});
let durableResult = recordValue(durableStarted.structuredContent);
const taskId = durableResult.taskId;
if (typeof taskId !== "string") {
  throw new Error(`candidate durable command did not detach to a task: ${JSON.stringify(durableResult)}`);
}
for (let attempt = 0; attempt < 40; attempt += 1) {
  const task = await callTool("task_get", { workspace_id: workspaceId, task_id: taskId });
  durableResult = recordValue(task.structuredContent);
  if (!["working", "input_required"].includes(String(durableResult.status ?? ""))) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (
  durableResult.status !== "completed"
  || durableResult.exitCode !== 0
) {
  throw new Error(`candidate durable task smoke failed: ${JSON.stringify(durableResult)}`);
}
const durableRunId = durableResult.runId;
if (typeof durableRunId !== "string") throw new Error("candidate durable result is missing runId");
const durableOutput = await readRunOutput(durableRunId);
if (!durableOutput.includes("candidate-durable-ok")) {
  throw new Error(`candidate durable output verification failed: ${JSON.stringify(durableOutput)}`);
}

const worktreeOpened = await callTool("open_workspace", {
  path: workspacePath,
  mode: "worktree",
  base_ref: "HEAD",
}, "windows-http-smoke-worktree");
const worktreeResult = recordValue(worktreeOpened.structuredContent);
const worktreeWorkspaceId = worktreeResult.workspaceId;
if (typeof worktreeWorkspaceId !== "string" || worktreeWorkspaceId === workspaceId) {
  throw new Error(`candidate worktree smoke did not return an isolated workspace: ${JSON.stringify(worktreeResult)}`);
}
const worktreeCommand = await callTool("exec_command", {
  workspaceId: worktreeWorkspaceId,
  cmd: "git rev-parse --is-inside-work-tree",
});
const worktreeCommandResult = recordValue(worktreeCommand.structuredContent);
if (
  worktreeCommandResult.exitCode !== 0
  || !String(worktreeCommandResult.result ?? worktreeCommandResult.output ?? "").includes("true")
) {
  throw new Error(`candidate worktree command smoke failed: ${JSON.stringify(worktreeCommandResult)}`);
}

console.log(JSON.stringify({
  ok: true,
  oauth: true,
  protocol: "2026-07-28",
  workspaceId,
  command: "passed",
  pty: "passed",
  durable: "passed",
  worktree: "passed",
  worktreeWorkspaceId,
  artifactNativeE2e: "not-run-without-host-native-file",
  toolNames,
  schemas: Object.fromEntries(
    tools
      .filter((tool) => tool.name && [
        "open_workspace",
        "exec_command",
        "write_stdin",
        "task_start",
        "task_get",
        "task_cancel",
        "download_artifact",
      ].includes(tool.name))
      .map((tool) => [tool.name!, tool.inputSchema ?? null]),
  ),
}, null, 2));

async function callTool(
  name: string,
  args: Record<string, unknown>,
  session = "windows-http-smoke",
): Promise<Record<string, unknown>> {
  const response = await postMcp<{ structuredContent?: Record<string, unknown> }>("tools/call", {
    name,
    arguments: args,
    _meta: { "openai/session": session },
  });
  return { structuredContent: response.result?.structuredContent ?? {} };
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRunOutput(runId: string): Promise<string> {
  const match = /^run_(\d{4})(\d{2})(\d{2})\d{6}_[A-Za-z0-9]+$/.exec(runId);
  if (!match) throw new Error(`unexpected run id: ${runId}`);
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return readFile(join(runStoreRoot(), day, runId, "output.log"), "utf8");
}
