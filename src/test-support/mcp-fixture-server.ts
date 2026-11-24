import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "synrex-mcp-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Returns the supplied text for MCP transport tests.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
    structuredContent: { echo: text },
  }),
);

server.registerTool(
  "fail",
  {
    description: "Returns an MCP tool error without closing the connection.",
    inputSchema: {},
  },
  async () => ({
    isError: true,
    content: [{ type: "text", text: "fixture tool error" }],
  }),
);

server.registerTool(
  "env_probe",
  {
    description: "Checks explicit environment forwarding for the MCP transport test.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "environment checked" }],
    structuredContent: {
      ambientSecretPresent: process.env.DEVSPACE_TEST_PARENT_SECRET !== undefined,
      configuredSecret: process.env.MCP_FIXTURE_CONFIG_SECRET ?? null,
      pathPresent: Boolean(process.env.PATH),
      pid: process.pid,
    },
  }),
);

server.registerTool(
  "crash",
  {
    description: "Terminates the fixture process to test transport invalidation.",
    inputSchema: {},
  },
  async () => {
    process.exit(1);
    return { content: [{ type: "text", text: "unreachable" }] };
  },
);

await server.connect(new StdioServerTransport());
