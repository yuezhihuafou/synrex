import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ProjectMemoryHydration, ProjectMemoryItem, ProjectMemoryPort, ProjectMemoryRecall,
} from "./project-memory-port.js";
import { DisabledProjectMemoryPort } from "./project-memory-port.js";

type ToolArguments = Record<string, unknown>;
export type MemHubToolInvoker = (name: string, args: ToolArguments, signal: AbortSignal) => Promise<unknown>;

export interface MemHubAdapterOptions {
  endpoint: string;
  timeoutMs?: number;
  /** Test seam; production uses the MCP SDK and closes every request. */
  invoke?: MemHubToolInvoker;
}

/**
 * This adapter uses only MemHub's published MCP tool contract. No imports from
 * MemHub source, database schemas, memory layers or server runtime.
 */
export class MemHubMemoryAdapter implements ProjectMemoryPort {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly invoke: MemHubToolInvoker;

  constructor(options: MemHubAdapterOptions) {
    const url = new URL(options.endpoint);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("MemHub MCP must use HTTPS or an explicitly configured loopback endpoint.");
    }
    this.endpoint = url.toString();
    this.timeoutMs = Math.min(10_000, Math.max(500, options.timeoutMs ?? 3_500));
    this.invoke = options.invoke ?? ((name, args, signal) => this.invokeMcp(name, args, signal));
  }

  async recall(input: { project: string; query: string; maxBytes?: number }): Promise<ProjectMemoryRecall> {
    const project = input.project.trim();
    if (!project) return { status: "ambiguous", reason: "An explicit MemHub project slug is required." };
    const maxBytes = Math.min(16_000, Math.max(2_000, input.maxBytes ?? 8_000));
    try {
      const payload = asObject(await this.call("memmy_context", {
        query: input.query.slice(0, 4_000),
        project,
        workspace_project: project,
        detail: "brief",
        max_content_bytes: maxBytes,
        cross_project_skills: false,
        limit: 6,
      }));
      if (!payload || payload.resolvedProjectId !== project || payload.recallScope !== "global_and_project") {
        return { status: "ambiguous", reason: "MemHub did not resolve the requested project exactly." };
      }
      const items: ProjectMemoryItem[] = [];
      let remaining = maxBytes;
      const sources: Array<[keyof typeof payload, ProjectMemoryItem["source"]]> = [
        ["projectMemory", "project"], ["globalMemory", "global"],
        ["reusableSkills", "skill"], ["projectArchitecture", "architecture_context"],
      ];
      for (const [key, source] of sources) {
        const raw = payload[key];
        if (!Array.isArray(raw)) continue;
        for (const item of raw) {
          const value = asObject(item);
          if (!value || typeof value.content !== "string" || typeof value.id !== "string") continue;
          if (value.projectId && value.projectId !== project && source !== "global") continue;
          const content = utf8Bound(value.content, remaining);
          if (!content) continue;
          items.push({
            id: value.id,
            content,
            source,
            ...(content !== value.content ? { truncated: true } : {}),
            ...(typeof value.evidenceRef === "string" ? { evidenceRef: value.evidenceRef } : {}),
            ...(typeof value.updatedAt === "string" ? { revision: value.updatedAt } : {}),
          });
          remaining -= Buffer.byteLength(content, "utf8");
          if (remaining < 256) break;
        }
        if (remaining < 256) break;
      }
      return { status: "ok", project, items, bytes: maxBytes - remaining };
    } catch {
      // Optional memory never blocks the authoritative coding workflow.
      return { status: "unavailable", reason: "MemHub MCP unavailable, timed out, or incompatible." };
    }
  }

  async hydrate(evidenceRef: string, maxBytes = 16_000): Promise<ProjectMemoryHydration> {
    if (!evidenceRef || evidenceRef.length > 512 || !/^[a-zA-Z0-9:_./@-]+$/.test(evidenceRef)) {
      return { status: "unavailable", reason: "Invalid exact memory evidence reference." };
    }
    try {
      const payload = asObject(await this.call("memhub_memory", {
        action: "load", evidence_ref: evidenceRef,
      }));
      const item = asObject(payload?.item);
      if (!item || typeof item.content !== "string") {
        return { status: "unavailable", reason: "MemHub returned no exact evidence content." };
      }
      const bounded = utf8Bound(item.content, Math.min(64_000, Math.max(1_000, maxBytes)));
      return {
        status: "ok", evidenceRef, content: bounded,
        truncated: Buffer.byteLength(item.content, "utf8") > Buffer.byteLength(bounded, "utf8"),
      };
    } catch {
      return { status: "unavailable", reason: "MemHub evidence unavailable or incompatible." };
    }
  }

  private async call(name: string, args: ToolArguments): Promise<unknown> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const invocation = this.invoke(name, args, controller.signal);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("MemHub MCP timeout"));
        }, this.timeoutMs);
      });
      return unwrapToolResult(await Promise.race([invocation, deadline]));
    } finally { if (timer) clearTimeout(timer); }
  }

  private async invokeMcp(name: string, args: ToolArguments, signal: AbortSignal): Promise<unknown> {
    const client = new Client({ name: "synrex-optional-memory", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
    try {
      await client.connect(transport, { signal, timeout: this.timeoutMs });
      // MemHub and Synrex release independently. The deployed MemHub schema
      // may lag its current upstream source: negotiate supported optional
      // arguments rather than assuming the latest tool definition shipped.
      const catalog = await client.listTools(undefined, { signal, timeout: this.timeoutMs });
      const tool = catalog.tools.find((item) => item.name === name);
      if (!tool) throw new Error("Required read-only MemHub tool is unavailable.");
      const allowed = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      if ((name === "memmy_context" &&
           (!allowed.has("query") || !allowed.has("project") || !allowed.has("workspace_project"))) ||
          (name === "memhub_memory" && (!allowed.has("action") || !allowed.has("evidence_ref")))) {
        throw new Error("MemHub tool lacks required project or evidence scope parameters.");
      }
      const compatibleArgs = Object.fromEntries(
        Object.entries(args).filter(([key]) => allowed.has(key)),
      );
      return await client.callTool({ name, arguments: compatibleArgs }, undefined, {
        signal, timeout: this.timeoutMs,
      });
    } finally { await client.close().catch(() => undefined); }
  }
}

export function createOptionalProjectMemoryPort(
  env: NodeJS.ProcessEnv = process.env,
): ProjectMemoryPort {
  const endpoint = env.SYNREX_MEMHUB_URL?.trim();
  if (!endpoint) return new DisabledProjectMemoryPort();
  try { return new MemHubMemoryAdapter({ endpoint }); }
  catch { return new DisabledProjectMemoryPort(); }
}

function unwrapToolResult(value: unknown): unknown {
  const record = asObject(value);
  if (!record) return value;
  if (record.isError === true) throw new Error("MemHub tool returned an error.");
  if (asObject(record.structuredContent)) return record.structuredContent;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content.find((item) => asObject(item)?.type === "text");
    const body = asObject(text)?.text;
    if (typeof body === "string") return JSON.parse(body);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function utf8Bound(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
}
