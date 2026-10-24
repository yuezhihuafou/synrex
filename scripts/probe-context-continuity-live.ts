/**
 * Read-only MemHub contract smoke from a disposable Synrex checkout.
 * Requires an explicitly supplied endpoint; never mutates MemHub state.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemHubMemoryAdapter } from "../src/memhub-memory-adapter.js";

const endpoint = process.env.SYNREX_MEMHUB_URL;
if (!endpoint) throw new Error("SYNREX_MEMHUB_URL required for optional live smoke.");

const client = new Client({ name: "synrex-memory-contract-probe", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));
let selectedProject: string | undefined;
let rawContextCheck: Record<string, unknown> | undefined;
try {
  await client.connect(transport, { timeout: 8_000 });
  const response = await client.callTool({
    name: "memmy_project_list", arguments: { query: "synrex", limit: 8 },
  }, undefined, { timeout: 8_000 });
  if (response.isError) throw new Error("MemHub project list rejected read-only request.");
  const text = response.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MemHub project list returned no JSON text.");
  const payload = JSON.parse(text);
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  const slugs = projects.map((item: Record<string, unknown>) =>
    String(item.projectId ?? item.project_id ?? item.slug ?? item.project ?? item.id ?? "")).filter(Boolean);
  selectedProject = process.env.SYNREX_MEMHUB_PROJECT ||
    slugs.find((slug: string) => /^synrex$/i.test(slug));
  console.log(JSON.stringify({ step: "project_list", count: projects.length, slugs }));
  if (selectedProject) {
    try {
      const tools = await client.listTools(undefined, { timeout: 8_000 });
      const schema = tools.tools.find((tool) => tool.name === "memmy_context")?.inputSchema;
      console.log(JSON.stringify({ step: "actual_schema", properties: Object.keys(schema?.properties ?? {}) }));
      const supported = new Set(Object.keys(schema?.properties ?? {}));
      const allArgs = {
        query: "Synrex workflow recovery and subagent evidence",
        detail: "brief", project: selectedProject, workspace_project: selectedProject,
        max_content_bytes: 8_000, cross_project_skills: false, limit: 6,
      };
      const negotiated = Object.fromEntries(Object.entries(allArgs).filter(([key]) => supported.has(key)));
      const raw = await client.callTool({
        name: "memmy_context",
        arguments: negotiated,
      }, undefined, { timeout: 25_000 });
      const body = raw.content.find((item) => item.type === "text")?.text;
      let parsed: Record<string, unknown> = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* tool returned an error text */ }
      rawContextCheck = {
        isError: raw.isError ?? false, keys: Object.keys(parsed).slice(0, 22),
        project: parsed.resolvedProjectId, scope: parsed.recallScope,
        ...(raw.isError || Object.keys(parsed).length === 0 ? {
          errorPreview: String(body ?? "").slice(0, 280),
        } : {}),
      };
    } catch (error) {
      rawContextCheck = { error: String(error).slice(0, 220) };
    }
  }
  if (rawContextCheck) console.log(JSON.stringify({ step: "raw_context", ...rawContextCheck }));
} finally { await client.close().catch(() => undefined); }

if (selectedProject) {
  const memory = new MemHubMemoryAdapter({ endpoint, timeoutMs: 8_000 });
  const response = await memory.recall({
    project: selectedProject, query: "Synrex workflow recovery and subagent evidence", maxBytes: 8_000,
  });
  console.log(JSON.stringify({
    step: "recall", project: selectedProject, status: response.status,
    ...(response.status === "ok" ? {
      itemCount: response.items.length, bytes: response.bytes,
      exactRefs: response.items.filter((item) => item.evidenceRef).length,
    } : { reason: response.reason }),
  }));
  if (response.status !== "ok") process.exitCode = 2;
} else {
  console.log(JSON.stringify({ step: "recall", status: "skipped", reason: "no explicit or exact Synrex project" }));
}
