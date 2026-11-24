import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import type { McpServerConfig } from "./config-schema.js";
import { McpMountManager } from "./mcp-mount-manager.js";

const fixturePath = fileURLToPath(new URL("./test-support/mcp-fixture-server.ts", import.meta.url));

function fixtureConfig(): McpServerConfig {
  return {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", fixturePath],
    cwd: process.cwd(),
    env: { MCP_FIXTURE_CONFIG_SECRET: "configured-fixture-secret" },
    enabled: true,
    timeoutMs: 3_000,
  };
}

test("MCP mount lazily connects, discovers schemas, invokes tools, and closes", async (t) => {
  const manager = new McpMountManager([fixtureConfig()]);
  t.after(() => manager.close());

  assert.deepEqual(manager.listServers(), [{
    name: "fixture", transport: "stdio", enabled: true, connected: false,
  }]);

  const tools = await manager.listTools("fixture");
  assert.ok(tools.some((tool) => tool.name === "echo"));
  assert.ok(tools.some((tool) => tool.name === "fail"));
  assert.equal(manager.listServers()[0]?.connected, true);

  const result = await manager.callTool("fixture", "echo", { text: "gateway" });
  assert.equal(result.structuredContent?.echo, "gateway");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "echo:gateway");

  const toolError = await manager.callTool("fixture", "fail", {});
  assert.equal(toolError.isError, true, "remote MCP tool errors must pass through without discarding the connection");
  assert.equal(manager.listServers()[0]?.connected, true);

  const priorAmbientSecret = process.env.DEVSPACE_TEST_PARENT_SECRET;
  process.env.DEVSPACE_TEST_PARENT_SECRET = "ambient-parent-secret";
  try {
    const environment = await manager.callTool("fixture", "env_probe", {});
    assert.equal(environment.structuredContent?.ambientSecretPresent, false,
      "ambient parent-process secrets must not be inherited by stdio MCP servers");
    assert.equal(environment.structuredContent?.configuredSecret, "configured-fixture-secret",
      "owner-configured environment variables must be forwarded");
    assert.equal(environment.structuredContent?.pathPresent, true,
      "safe runtime variables such as PATH must remain available");
    const environmentAgain = await manager.callTool("fixture", "env_probe", {});
    assert.equal(environmentAgain.structuredContent?.pid, environment.structuredContent?.pid,
      "healthy stdio connections must be reused instead of spawning one process per call");
  } finally {
    if (priorAmbientSecret === undefined) delete process.env.DEVSPACE_TEST_PARENT_SECRET;
    else process.env.DEVSPACE_TEST_PARENT_SECRET = priorAmbientSecret;
  }

  await assert.rejects(() => manager.callTool("fixture", "not-advertised", {}), /does not advertise tool/);
  await assert.rejects(() => manager.callTool("fixture", "crash", {}), /failed|closed|exit|transport/i);
  assert.equal(manager.listServers()[0]?.connected, false,
    "a broken stdio transport must be invalidated rather than reused");
  const recovered = await manager.callTool("fixture", "echo", { text: "recovered" });
  assert.equal(recovered.structuredContent?.echo, "recovered");
  assert.equal(manager.listServers()[0]?.connected, true);
  await manager.close();
  assert.equal(manager.listServers()[0]?.connected, false);
  await assert.rejects(() => manager.listTools("fixture"), /manager is closed/);
});

test("MCP mount does not start disabled servers", async () => {
  const config = { ...fixtureConfig(), name: "disabled", enabled: false } as McpServerConfig;
  const manager = new McpMountManager([config]);
  try {
    assert.equal(manager.listServers()[0]?.connected, false);
    await assert.rejects(() => manager.listTools("disabled"), /is disabled/);
    assert.equal(manager.listServers()[0]?.connected, false);
  } finally {
    await manager.close();
  }
});

test("Streamable HTTP mount discovers and invokes a real remote MCP server", async (t) => {
  const app = express();
  app.use(express.json());
  app.get("/mcp", (_req, res) => res.status(405).end());
  app.delete("/mcp", (_req, res) => res.status(405).end());
  app.post("/mcp", async (req, res) => {
    if (req.header("x-mcp-fixture") !== "configured-header") {
      res.status(401).end();
      return;
    }
    const server = new McpServer({ name: "synrex-http-fixture", version: "1.0.0" });
    server.registerTool("echo_http", {
      description: "Echoes text over Streamable HTTP.",
      inputSchema: { text: z.string() },
    }, async ({ text }) => ({
      content: [{ type: "text", text: `http:${text}` }],
      structuredContent: { echo: text },
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).end();
    } finally {
      res.once("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });

  const address = httpServer.address() as AddressInfo;
  const manager = new McpMountManager([{
    name: "http-fixture",
    transport: "streamable-http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { "x-mcp-fixture": "configured-header" },
    enabled: true,
    timeoutMs: 10_000,
  }]);
  t.after(() => manager.close());

  const tools = await manager.listTools("http-fixture");
  assert.ok(tools.some((tool) => tool.name === "echo_http"));
  const result = await manager.callTool("http-fixture", "echo_http", { text: "gateway" });
  assert.equal(result.structuredContent?.echo, "gateway");
  const textResult = result.content.find((item) => item.type === "text");
  assert.equal(textResult?.type === "text" ? textResult.text : undefined, "http:gateway");
});
