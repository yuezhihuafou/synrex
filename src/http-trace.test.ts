import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { ServerConfig } from "./config.js";
import { requestTraceMiddleware } from "./http-trace.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";

test("MCP HTTP tracing counts streamed body bytes and retains valid W3C parent context", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "synrex-http-observe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(root);
  const app = express();
  const config = { logging: { requests: false, assets: false } } as ServerConfig;
  app.use(requestTraceMiddleware(config, diagnostics, () => ({})));
  app.get("/mcp", (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("first\n");
    res.end("last\n");
  });
  const server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  const trace = "fedcba9876543210fedcba9876543210";
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { traceparent: `00-${trace}-0123456789abcdef-01` },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "first\nlast\n");
  await new Promise(resolve => setImmediate(resolve));
  const completed = diagnostics.read().find(e => e.event === "mcp_finished");
  assert.ok(completed);
  assert.equal(completed.otelTraceId, trace);
  assert.equal(completed.otelParentSpanId, "0123456789abcdef");
  assert.match(completed.otelSpanId!, /^[a-f0-9]{16}$/);
  assert.equal(completed.outputBytes, Buffer.byteLength("first\nlast\n"));
  assert.equal(completed.responseMode, "sse");
  assert.equal(completed.requestId, response.headers.get("x-synrex-request-id"));
});

test("MCP response byte count includes chunked string and binary writes without Content-Length", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "synrex-http-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = new DiagnosticTrace(root);
  const app = express();
  const config = { logging: { requests: false } } as ServerConfig;
  app.use(requestTraceMiddleware(config, diagnostics, () => ({})));
  app.post("/mcp", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.write('{"message":"');
    res.end(Buffer.from('你好"}'));
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    const body = await response.text();
    assert.equal(body, '{"message":"你好"}');
    const finish = diagnostics.read().find((event) => event.event === "mcp_finished");
    assert.equal(finish?.outputBytes, Buffer.byteLength(body));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
