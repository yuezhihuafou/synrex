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
import { requestTraceMiddleware, bodyReadyTrace } from "./http-trace.js";
import { countToolInputTokens, countToolOutputTokens } from "./console-token-meter.js";
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

test("MCP tracing follows configured public path prefix", async t => {
  const root=await mkdtemp(path.join(tmpdir(),"synrex-http-prefix-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const diagnostics=new DiagnosticTrace(root),app=express();
  const config={publicBaseUrl:"https://owner.example/server",logging:{requests:false,assets:false}} as ServerConfig;
  app.use(requestTraceMiddleware(config,diagnostics,()=>({})));
  app.use(express.json());app.use(bodyReadyTrace);
  app.post("/server/mcp",(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const port=(server.address() as AddressInfo).port;
    const response=await fetch(`http://127.0.0.1:${port}/server/mcp`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{path:"x"}}}),
    });
    assert.equal(response.status,200);await response.text();
    await new Promise(resolve=>setImmediate(resolve));
    const events=diagnostics.read();
    assert.ok(events.some(e=>e.event==="mcp_received"));
    assert.ok(events.some(e=>e.event==="mcp_body_ready"));
    assert.ok(events.some(e=>e.event==="mcp_finished"));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("real MCP tool text counts are recorded without storing prompt or response content", async t => {
  const root=await mkdtemp(path.join(tmpdir(),"synrex-meter-http-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const diagnostics=new DiagnosticTrace(root);
  const app=express();
  app.use(requestTraceMiddleware({logging:{requests:false}} as ServerConfig,diagnostics,()=>({})));
  app.use(express.json());app.use(bodyReadyTrace);
  const body={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{path:"private file"}}};
  const response={jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:"secret result"}]}};
  app.post("/mcp",(_req,res)=>{
    res.setHeader("Content-Type","text/event-stream");
    res.write("event: message\n");
    res.end(`data: ${JSON.stringify(response)}\n\n`);
  });
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const port=(server.address() as AddressInfo).port;
    const res=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    });
    assert.equal(res.status,200);await res.text();
    let events=diagnostics.read();
    for(let i=0;i<50 && events.filter(e=>e.event==="tool_tokens_measured").length<2;i++){
      await new Promise(resolve=>setTimeout(resolve,20));events=diagnostics.read();
    }
    assert.equal(events.find(e=>e.event==="tool_tokens_measured" && e.inputTokens!==undefined)?.inputTokens,countToolInputTokens(body));
    assert.equal(events.find(e=>e.event==="tool_tokens_measured" && e.outputTokens!==undefined)?.outputTokens,
      countToolOutputTokens(`event: message\ndata: ${JSON.stringify(response)}\n\n`,"sse"));
    const {readFile}=await import("node:fs/promises");
    const raw=await readFile(diagnostics.file,"utf8");
    assert.ok(!raw.includes("private file")&&!raw.includes("secret result"));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
