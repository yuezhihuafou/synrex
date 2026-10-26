/** End-to-end Core + optional stable ingress QA, disposable OAuth and SQLite.
 * No production token, configuration, socket or URL is read or mutated.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDevspaceConfig } from '../dist/config-schema.js';
import { createIngressGate } from './ingress-gate.mjs';
import { sendIngressCommand } from './ingress-ctl.mjs';

async function port() {
  const server = createTcpServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const selected = server.address().port;
  await new Promise((done) => server.close(done));
  return selected;
}

async function waitHealthy(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('isolated Core exited before health check');
    try {
      const res = await fetch(url + '/healthz', {signal: AbortSignal.timeout(500)});
      if (res.status === 200) return;
    } catch {}
    await delay(100);
  }
  throw Error('isolated Core did not become healthy');
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    delay(3500),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const release = process.argv[2] ?? '.';
const temp = await mkdtemp(join(tmpdir(), 'synrex-p0-http-'));
const confDir = join(temp, 'conf');
const stateDir = join(temp, 'state');
const controlSocket = join(temp, 'ingress.sock');
const innerPort = await port();
const outerPort = await port();
let core;
let gate;
let stderr = '';
const publicOrigin = 'https://synrex.example.test';

try {
  await mkdir(confDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const config = defaultDevspaceConfig();
  config.server = {
    ...config.server, host: '127.0.0.1',
    port: outerPort, publicBaseUrl: publicOrigin, allowedHosts: [],
    trustProxy: false,
  };
  config.cluster = { ...config.cluster, role: 'standalone', gatewayUrl: null, placementRules: [] };
  config.storage = { ...config.storage, stateDir };
  config.workspaces = { ...config.workspaces, allowedRoots: [temp] };
  await writeFile(join(confDir, 'config.jsonc'), JSON.stringify(config, null, 2), {mode: 0o600});
  const env = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: confDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: randomBytes(32).toString('base64url'),
    SYNREX_CORE_LISTEN_PORT: String(innerPort),
    DEVSPACE_COMPACT_RUN_ROOT: join(temp, 'runs'),
  };
  const start = () => {
    const proc = spawn(process.execPath, [join(release, 'dist/cli.js'), 'serve'], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2500); });
    return proc;
  };
  core = start();
  await waitHealthy('http://127.0.0.1:' + innerPort, core);
  gate = createIngressGate({
    listenPort: outerPort, upstreamPort: innerPort,
    controlSocket, maxPendingMs: 8000,
  });
  await gate.start();
  const entry = 'http://127.0.0.1:' + outerPort;
  const discovery = await fetch(entry + '/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200, 'proxy must preserve public OAuth discovery');
  const metadata = await discovery.json();
  assert.equal(new URL(metadata.issuer).origin, publicOrigin, 'port relocation cannot change the OAuth issuer');
  assert.equal((await fetch(entry + '/mcp')).status, 401, 'unauthenticated MCP remains protected');
  assert.equal((await fetch(entry + '/console')).status, 200, 'Console remains available');
  assert.equal((await fetch(entry + '/console/api/snapshot')).status, 401, 'Console JSON remains private');
  const cookieResponse = await fetch(entry + '/console/api/login', {
    method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: env.DEVSPACE_OAUTH_OWNER_TOKEN }),
  });
  assert.equal(cookieResponse.status, 200, 'owner login must survive proxy and relocated Core');
  const cookieHeader = cookieResponse.headers.get('set-cookie') ?? '';
  assert.match(cookieHeader, /Secure/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await fetch(entry + '/console/api/snapshot', {
    headers: { cookie },
  })).status, 200);
  const originalPid = core.pid;
  await sendIngressCommand(controlSocket, 'PAUSE');
  const pending = fetch(entry + '/healthz');
  await delay(140);
  const stats = await sendIngressCommand(controlSocket, 'STATUS');
  assert.equal(stats.paused, true);
  assert.equal(stats.active, 0);
  assert.ok(stats.pending >= 1);
  await stop(core);
  core = start();
  await waitHealthy('http://127.0.0.1:' + innerPort, core);
  await sendIngressCommand(controlSocket, 'RESUME');
  assert.equal((await pending).status, 200);
  assert.equal((await fetch(entry + '/.well-known/oauth-authorization-server')).status, 200);
  assert.equal((await fetch(entry + '/console/api/snapshot', {headers: {cookie}})).status, 200);
  console.log(JSON.stringify({
    qa: 'passed', entry: 'ephemeral loopback only', singleCoreWriter: true,
    oldCorePid: originalPid, newCorePid: core.pid, publicIssuerPreserved: true,
    OAuthDiscovery: true, consoleLoginAndSessionPreserved: true, mcpUnauthorizedDenied: true,
    queuedRequestThroughRestart: true, gateRemainedListening: true,
  }));
} catch (error) {
  console.error('STABLE_INGRESS_QA_FAILED', error.message, stderr);
  process.exitCode = 1;
} finally {
  await gate?.close();
  await stop(core);
  await rm(temp, {recursive: true, force: true});
}
