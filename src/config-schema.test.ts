import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  devspaceConfigJsonSchema,
  devspaceConfigSchema,
} from "./config-schema.js";

assert.throws(
  () => devspaceConfigSchema.parse({ configVersion: 1, typo: true }),
  /Unrecognized key/,
);

const shortHostDeadline = devspaceConfigSchema.parse({ configVersion: 1 });
assert.equal(shortHostDeadline.cluster.requestTimeoutMs, 100_000,
  "default RPC deadline should return before the observed host transport cutoff");
assert.equal(devspaceConfigSchema.parse({
  configVersion: 1, cluster: { requestTimeoutMs: 240_000 },
}).cluster.requestTimeoutMs, 240_000, "explicit long-lived host transports retain an override");

for (const url of [
  "https://tunnel.example.com/v1/mcp/tunnel_123",
  "http://localhost:7676/mcp",
  "http://127.0.0.1:7676/mcp",
  "http://[::1]:7676/mcp",
]) {
  assert.doesNotThrow(() => devspaceConfigSchema.parse({
    configVersion: 1, oauth: { allowedResourceUrls: [url] },
  }), url);
}
for (const url of [
  "http://tunnel.example.com/mcp", "http://192.168.1.1/mcp",
  "http://localhost.example.com/mcp", "http://127.0.0.1.example.com/mcp",
  "http://[::2]/mcp", "ftp://localhost/mcp", "file:///mcp",
  "custom://tunnel.example.com/mcp", "not-a-url",
]) {
  assert.equal(devspaceConfigSchema.safeParse({
    configVersion: 1, oauth: { allowedResourceUrls: [url] },
  }).success, false, url);
}

const defaultMcpConfig = devspaceConfigSchema.parse({ configVersion: 1 }).mcp;
assert.deepEqual(defaultMcpConfig.servers, [], "MCP mounts are opt-in and default to an empty list");

const configuredMcp = devspaceConfigSchema.parse({
  configVersion: 1,
  mcp: {
    servers: [
      { name: "agent-desktop", transport: "stdio", command: "agent-desktop", args: ["mcp"] },
      { name: "private-remote", transport: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer test-secret" } },
    ],
  },
});
assert.equal(configuredMcp.mcp.servers[0]?.enabled, true);
assert.equal(configuredMcp.mcp.servers[0]?.timeoutMs, 30_000);
assert.equal(configuredMcp.mcp.servers[1]?.transport, "streamable-http");
assert.doesNotThrow(() => devspaceConfigSchema.parse({
  configVersion: 1,
  mcp: { servers: [{ name: "local-http", transport: "streamable-http", url: "http://127.0.0.1:8765/mcp" }] },
}), "HTTP is permitted for loopback MCP servers");

for (const url of [
  "http://mcp.example.com/mcp",
  "http://192.168.1.20:8080/mcp",
  "https://user:password@mcp.example.com/mcp",
]) {
  assert.equal(devspaceConfigSchema.safeParse({
    configVersion: 1,
    mcp: { servers: [{ name: "remote", transport: "streamable-http", url }] },
  }).success, false, `unsafe MCP URL must be rejected: ${url}`);
}

assert.equal(devspaceConfigSchema.safeParse({
  configVersion: 1,
  mcp: { servers: [
    { name: "duplicate", transport: "stdio", command: "one" },
    { name: "duplicate", transport: "stdio", command: "two" },
  ] },
}).success, false, "duplicate MCP server names must be rejected");
assert.equal(devspaceConfigSchema.safeParse({
  configVersion: 1,
  mcp: { servers: Array.from({ length: 17 }, (_, index) => ({
    name: `server-${index}`, transport: "stdio", command: "fixture",
  })) },
}).success, false, "MCP server count must be bounded");

const generatedSchema = `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`;
const committedSchema = readFileSync(
  new URL("../schema/v1/devspace.schema.json", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");

console.log("config schema tests passed");
