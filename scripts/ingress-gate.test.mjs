import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIngressGate } from './ingress-gate.mjs';
import { sendIngressCommand } from './ingress-ctl.mjs';

async function backend(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function http(port, path = '/', body = '') {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, method: body ? 'POST' : 'GET', path,
      headers: { host: 'synrex.example.test', ...(body ? { 'content-type': 'text/plain' } : {}) } }, (res) => {
      let result = '';
      res.on('data', (chunk) => { result += chunk; });
      res.on('end', () => done({ status: res.statusCode, body: result }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function control(path, command) {
  return new Promise((done, reject) => {
    const socket = connect(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', (chunk) => { out += chunk; });
    socket.on('end', () => done(JSON.parse(out)));
    socket.on('error', reject);
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('ingress preserves OAuth paths, host, POST body and response without rewriting authorization', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  const original = await backend(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'content-type': 'text/plain' });
    res.end(req.method + ' ' + req.url + ' ' + req.headers.host + ' ' + body);
  });
  const socket = join(tmp, 'control.sock');
  const ingress = createIngressGate({ upstreamPort: original.port, controlSocket: socket });
  t.after(async () => { await ingress.close(); await original.close(); await rm(tmp, { recursive: true, force: true }); });
  const port = await ingress.start();
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  const result = await http(port, '/mcp?probe=1', 'action=read');
  assert.equal(result.status, 201);
  assert.equal(result.body, 'POST /mcp?probe=1 synrex.example.test action=read');
  assert.deepEqual(await control(socket, 'STATUS'), { paused: false, active: 0, pending: 0, upstreamPort: original.port });
  assert.equal((await sendIngressCommand(socket, 'STATUS')).active, 0);
});

test('PAUSE queues new request and does not create another writable backend', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  let executed = 0;
  const original = await backend((_req, res) => { executed++; res.end('ready'); });
  const socket = join(tmp, 'control.sock');
  const ingress = createIngressGate({ upstreamPort: original.port, controlSocket: socket, pauseLeaseMs: 3000 });
  t.after(async () => { await ingress.close(); await original.close(); await rm(tmp, { recursive: true, force: true }); });
  const port = await ingress.start();
  await control(socket, 'PAUSE');
  const waiting = http(port, '/during-release');
  await sleep(90);
  assert.equal(executed, 0);
  assert.equal((await control(socket, 'STATUS')).pending, 1);
  await control(socket, 'RESUME');
  const response = await waiting;
  assert.equal(response.status, 200);
  assert.equal(response.body, 'ready');
  assert.equal(executed, 1);
});

test('unavailable backend recovers before dispatch without duplicating a request', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  const closed = await backend((_req, res) => res.end('unused'));
  const upstreamPort = closed.port;
  await closed.close();
  const socket = join(tmp, 'control.sock');
  const ingress = createIngressGate({ upstreamPort, controlSocket: socket, maxPendingMs: 1800 });
  t.after(async () => { await ingress.close(); await rm(tmp, { recursive: true, force: true }); });
  const port = await ingress.start();
  const waiting = http(port, '/recovered');
  await sleep(170);
  let hits = 0;
  const up = createServer((_req, res) => { hits++; res.end('recovered'); });
  await new Promise((done) => up.listen(upstreamPort, '127.0.0.1', done));
  t.after(() => new Promise((done) => up.close(done)));
  assert.deepEqual(await waiting, { status: 200, body: 'recovered' });
  assert.equal(hits, 1);
});

test('connected request is never automatically replayed after backend failure', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  let hits = 0;
  const original = await backend((_req, res) => {
    hits++;
    res.destroy();
  });
  const socket = join(tmp, 'control.sock');
  const ingress = createIngressGate({ upstreamPort: original.port, controlSocket: socket });
  t.after(async () => { await ingress.close(); await original.close(); await rm(tmp, { recursive: true, force: true }); });
  const port = await ingress.start();
  const response = await http(port, '/non-idempotent');
  assert.equal(response.status, 502);
  assert.equal(hits, 1);
});

test('long-lived GET SSE is gracefully closed while new requests remain queued', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  const original = await backend((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: finished\n\n'), 115);
  });
  const socket = join(tmp, 'control.sock');
  const ingress = createIngressGate({ upstreamPort: original.port, controlSocket: socket });
  t.after(async () => { await ingress.close(); await original.close(); await rm(tmp, { recursive: true, force: true }); });
  const port = await ingress.start();
  const current = http(port, '/stream');
  await sleep(40);
  assert.equal((await control(socket, 'STATUS')).active, 1);
  await control(socket, 'PAUSE');
  const next = http(port, '/next');
  await sleep(35);
  assert.equal((await control(socket, 'STATUS')).pending, 1);
  const streamed = await current;
  assert.match(streamed.body, /data: first[\s\S]*reconnect to continue/);
  assert.doesNotMatch(streamed.body, /data: finished/);
  assert.equal((await control(socket, 'STATUS')).active, 0);
  await control(socket, 'RESUME');
  assert.equal((await next).status, 200);
});

test('streaming POST is never terminated by PAUSE because its side effects may be unknown', async (t) => {
  const tmp=await mkdtemp(join(tmpdir(), 'synrex-ingress-'));
  let invoked=0;
  const original=await backend((_req, res)=>{
    invoked++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: in-progress\n\n');
    setTimeout(()=>res.end('data: completed\n\n'), 180);
  });
  const socket=join(tmp,'control.sock');
  const ingress=createIngressGate({upstreamPort:original.port,controlSocket:socket});
  t.after(async()=>{await ingress.close();await original.close();await rm(tmp,{recursive:true,force:true});});
  const port=await ingress.start();
  const ongoing=http(port,'/mcp','task-start');
  await sleep(40);
  assert.equal((await control(socket,'STATUS')).active,1);
  await control(socket,'PAUSE');
  assert.equal((await control(socket,'STATUS')).active,1);
  const response=await ongoing;
  assert.match(response.body, /data: in-progress[\s\S]*data: completed/);
  assert.equal(invoked,1);
  assert.equal((await control(socket,'STATUS')).active,0);
  await control(socket,'RESUME');
});
