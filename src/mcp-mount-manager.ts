import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config-schema.js";
import { DEVSPACE_VERSION } from "./version.js";

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface McpConnection {
  client: Client;
  transport: McpTransport;
  closed: boolean;
}

export interface MountedMcpServerSummary {
  name: string;
  transport: McpServerConfig["transport"];
  enabled: boolean;
  connected: boolean;
}

export interface MountedMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const TOOL_CATALOG_TTL_MS = 10_000;
const MAX_REMOTE_TOOLS = 128;
const MAX_TOOL_CATALOG_BYTES = 512_000;
const MAX_TOOL_RESULT_BYTES = 4_000_000;
const DESKTOP_ENV_VARS = [
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "GDK_BACKEND",
  "QT_QPA_PLATFORM",
  "QT_PLUGIN_PATH",
  "GTK_PATH",
  "DESKTOP_SESSION",
] as const;

export class McpMountManager {
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly connections = new Map<string, McpConnection>();
  private readonly pendingConnections = new Map<string, Promise<McpConnection>>();
  private readonly toolCatalogs = new Map<string, { loadedAt: number; tools: MountedMcpTool[] }>();
  private closed = false;

  constructor(configs: readonly McpServerConfig[]) {
    for (const config of configs) {
      if (this.configs.has(config.name)) {
        throw new Error(`Duplicate MCP server name: ${config.name}.`);
      }
      this.configs.set(config.name, config);
    }
  }

  listServers(): MountedMcpServerSummary[] {
    return [...this.configs.values()].map((config) => ({
      name: config.name,
      transport: config.transport,
      enabled: config.enabled,
      connected: this.connections.has(config.name),
    }));
  }

  async listTools(name: string, signal?: AbortSignal): Promise<MountedMcpTool[]> {
    return this.loadToolCatalog(name, true, signal);
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const config = this.getConfig(serverName);
    const tools = await this.loadToolCatalog(serverName, false, signal);
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP server '${serverName}' does not advertise tool '${toolName}'. Call mcp_tools to refresh its tool catalog.`);
    }

    const connection = await this.getConnection(config);
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        requestOptions(config.timeoutMs, signal),
      );
      if (!("content" in result) || !Array.isArray(result.content)) {
        throw new Error("The remote MCP server returned a task-augmented result, which this bridge does not support yet.");
      }
      const toolResult = result as CallToolResult;
      assertJsonSize(toolResult, MAX_TOOL_RESULT_BYTES, `MCP tool '${serverName}.${toolName}' result`);
      return toolResult;
    } catch (error) {
      if (connection.closed || isTransportFailure(error)) this.invalidate(serverName, connection);
      throw new Error(`MCP tool '${serverName}.${toolName}' failed: ${redactError(error, config)}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pendingConnections.values()];
    const connections = [...this.connections.values()];
    this.pendingConnections.clear();
    this.connections.clear();
    this.toolCatalogs.clear();
    for (const connection of connections) connection.closed = true;

    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === "fulfilled") connections.push(result.value);
    }
    await Promise.allSettled(
      [...new Set(connections)].map((connection) => connection.client.close()),
    );
  }

  private getConfig(name: string): McpServerConfig {
    if (this.closed) throw new Error("MCP mount manager is closed.");
    const config = this.configs.get(name);
    if (!config) throw new Error(`MCP server '${name}' is not configured on this execution node.`);
    if (!config.enabled) throw new Error(`MCP server '${name}' is disabled on this execution node.`);
    return config;
  }

  private async getConnection(config: McpServerConfig): Promise<McpConnection> {
    const existing = this.connections.get(config.name);
    if (existing && !existing.closed) return existing;
    if (existing?.closed) this.connections.delete(config.name);

    const pending = this.pendingConnections.get(config.name);
    if (pending) return pending;

    let connectionPromise: Promise<McpConnection>;
    connectionPromise = this.createConnection(config).then((connection) => {
      if (this.closed) {
        void connection.client.close().catch(() => undefined);
        throw new Error("MCP mount manager closed while the server was connecting.");
      }
      if (this.pendingConnections.get(config.name) === connectionPromise) {
        this.pendingConnections.delete(config.name);
      }
      this.connections.set(config.name, connection);
      // Keep the SDK's transport handlers intact: they settle pending RPCs.
      connection.client.onclose = () => this.invalidate(config.name, connection);
      connection.client.onerror = (error) => {
        if (isTransportFailure(error)) this.invalidate(config.name, connection);
      };
      return connection;
    }).catch((error) => {
      if (this.pendingConnections.get(config.name) === connectionPromise) {
        this.pendingConnections.delete(config.name);
      }
      throw new Error(`MCP server '${config.name}' connection failed: ${redactError(error, config)}`);
    });
    this.pendingConnections.set(config.name, connectionPromise);
    return connectionPromise;
  }

  private async createConnection(config: McpServerConfig): Promise<McpConnection> {
    const transport = createTransport(config);
    const client = new Client({ name: `synrex-mcp-${config.name}`, version: DEVSPACE_VERSION });
    try {
      await withDeadline(
        client.connect(transport),
        config.timeoutMs,
        `MCP server '${config.name}' connection`,
      );
      return { client, transport, closed: false };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async loadToolCatalog(
    name: string,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<MountedMcpTool[]> {
    const config = this.getConfig(name);
    const cached = this.toolCatalogs.get(name);
    if (!refresh && cached && Date.now() - cached.loadedAt < TOOL_CATALOG_TTL_MS) {
      return cached.tools;
    }

    const connection = await this.getConnection(config);
    try {
      const tools: MountedMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await connection.client.listTools(
          cursor ? { cursor } : undefined,
          requestOptions(config.timeoutMs, signal),
        );
        for (const value of page.tools) {
          tools.push(normalizeTool(value));
          if (tools.length > MAX_REMOTE_TOOLS) {
            throw new Error(`MCP server '${name}' advertises more than ${MAX_REMOTE_TOOLS} tools; narrow the server's tool surface.`);
          }
        }
        cursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0
          ? page.nextCursor
          : undefined;
      } while (cursor);

      assertJsonSize(tools, MAX_TOOL_CATALOG_BYTES, `MCP server '${name}' tool catalog`);
      this.toolCatalogs.set(name, { loadedAt: Date.now(), tools });
      return tools;
    } catch (error) {
      if (connection.closed || isTransportFailure(error)) this.invalidate(name, connection);
      throw new Error(`Unable to discover tools from MCP server '${name}': ${redactError(error, config)}`);
    }
  }

  private invalidate(name: string, connection: McpConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connections.get(name) === connection) this.connections.delete(name);
    this.toolCatalogs.delete(name);
    void connection.client.close().catch(() => undefined);
  }
}

function createTransport(config: McpServerConfig): McpTransport {
  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      // The SDK's allowlist omits ambient API tokens and other process secrets.
      // Additional variables must be explicitly granted by the local owner.
      env: { ...getStdioEnvironment(), ...config.env },
      stderr: "pipe",
    });
    // Drain diagnostics without forwarding potentially sensitive child output
    // into the Synrex service log or allowing the pipe to fill and deadlock.
    transport.stderr?.on("data", () => undefined);
    return transport;
  }

  return new StreamableHTTPClientTransport(
    new URL(config.url),
    Object.keys(config.headers).length > 0
      ? { requestInit: { headers: config.headers } }
      : undefined,
  );
}

function getStdioEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of DESKTOP_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith("()")) env[key] = value;
  }
  return env;
}

function normalizeTool(value: unknown): MountedMcpTool {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("External MCP server returned an invalid tool definition.");
  }
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || tool.name.length === 0
    || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error("External MCP server returned a tool without a valid name and input schema.");
  }
  return {
    name: tool.name,
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.outputSchema && typeof tool.outputSchema === "object" && !Array.isArray(tool.outputSchema)
      ? { outputSchema: tool.outputSchema as Record<string, unknown> }
      : {}),
    ...(tool.annotations && typeof tool.annotations === "object" && !Array.isArray(tool.annotations)
      ? { annotations: tool.annotations as Record<string, unknown> }
      : {}),
  };
}

function requestOptions(timeoutMs: number, parentSignal?: AbortSignal): { timeout: number; signal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    timeout: timeoutMs,
    signal: parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal,
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertJsonSize(value: unknown, maximumBytes: number, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable.`);
  }
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte response limit.`);
  }
}

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(connection|transport|channel|stream).*(closed|ended|reset)|\bEOF\b|ECONNRESET|EPIPE|not connected|broken pipe/i.test(message);
}

function redactError(error: unknown, config: McpServerConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = config.transport === "stdio"
    ? [...Object.values(config.env), ...config.args]
    : Object.values(config.headers);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join("[redacted]");
  }
  if (config.transport === "streamable-http") {
    const url = new URL(config.url);
    message = message.split(config.url).join(`${url.origin}${url.pathname}`);
    if (url.search) message = message.split(url.search).join("[redacted-query]");
  }
  return message.slice(0, 600);
}
