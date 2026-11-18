import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { diagnoseMcpConnections, probeMcp } from "./connect-diagnostics.js";

test("401 Bearer MCP and OAuth metadata are healthy on both routes", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/mcp") {
      response.writeHead(401, { "WWW-Authenticate": 'Bearer error="invalid_token"' }).end();
    } else if (request.url === "/.well-known/oauth-protected-resource/mcp") {
      response.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ authorization_servers: ["https://example.com"] }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const checks = await diagnoseMcpConnections("127.0.0.1", address.port, "http://127.0.0.1:" + address.port);
    assert.deepEqual(checks.map((check) => check.ok), [true, true, true]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("502 from proxy reports upstream failure", async () => {
  const server = createServer((_request, response) => response.writeHead(502).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const check = await probeMcp("http://127.0.0.1:" + address.port + "/mcp", "Public MCP");
    assert.equal(check.ok, false);
    assert.match(check.detail, /proxy cannot reach/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("connection refused yields diagnostic hint", async () => {
  const check = await probeMcp("http://127.0.0.1:1/mcp", "Local MCP");
  assert.equal(check.ok, false);
  assert.match(check.detail, /Connection refused|fetch failed/);
});
