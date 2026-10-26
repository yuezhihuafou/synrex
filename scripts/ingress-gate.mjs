/** Optional stable loopback ingress for a single, independently restarted Core.
 *  No OAuth handling, second database, cloud tunnel or autonomous task replay.
 *  Not installed by default. A real production port cutover is a separate step.
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createControlServer, connect as tcpConnect } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function createIngressGate({
  listenPort = 0, upstreamPort, controlSocket,
  maxPending = 48, maxPendingMs = 20_000, pauseLeaseMs = 30_000,
}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('upstreamPort must be a valid local TCP port');
  }
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error('listenPort must be a valid local TCP port');
  }
  if (!controlSocket || !controlSocket.startsWith('/')) throw new Error('controlSocket must be an absolute Unix socket path');

  const wake = new EventEmitter();
  let paused = false;
  let active = 0;
  let pending = 0;
  let pauseTimer;
  let listening = false;

  const snapshot = () => ({ paused, active, pending, upstreamPort });
  function resume() {
    paused = false;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    wake.emit('resume');
  }
  function pause() {
    paused = true;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = setTimeout(resume, pauseLeaseMs);
    pauseTimer.unref();
  }

  async function waitReady(req, res) {
    const until = Date.now() + maxPendingMs;
    if (pending >= maxPending) return null;
    pending += 1;
    try {
      while (Date.now() < until && !res.destroyed) {
        if (paused) {
          await Promise.race([
            new Promise((done) => {
              const handler = () => { clearTimeout(timer); done(); };
              const timer = setTimeout(() => { wake.off('resume', handler); done(); }, 200);
              wake.once('resume', handler);
            }),
          ]);
          continue;
        }
        const available = await new Promise((done) => {
          const target = tcpConnect({ host: '127.0.0.1', port: upstreamPort });
          target.once('connect', () => { target.destroy(); done(true); });
          target.once('error', () => { target.destroy(); done(false); });
        });
        if (available && !paused && !res.destroyed) return true;
        await delay(100);
      }
      return null;
    } finally {
      pending -= 1;
    }
  }

  const server = createHttpServer(async (req, res) => {
    let ready;
    try { ready = await waitReady(req, res); }
    catch { /* A failed connect is never evidence a request was dispatched. */ }
    if (res.destroyed) return;
    if (!ready) {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '1' });
      res.end('Synrex ingress unavailable before dispatch');
      return;
    }
    active += 1;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      active -= 1;
    }
    res.once('close', finish);
    const upstream = httpRequest({
      host: '127.0.0.1', port: upstreamPort, method: req.method,
      path: req.url, headers: req.headers,
      agent: false,
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
      answer.pipe(res);
    });
    upstream.once('error', () => {
      // Never replay an already connected request: its side effects are unknown.
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Synrex upstream request outcome unknown');
      } else if (!res.destroyed) res.destroy();
      finish();
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  const control = createControlServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(2500, () => socket.destroy());
    socket.once('data', (data) => {
      const operation = data.toString().trim().split(/\s/)[0];
      if (operation === 'PAUSE') pause();
      else if (operation === 'RESUME') resume();
      else if (operation !== 'STATUS') {
        socket.end(JSON.stringify({ error: 'unknown control operation' }) + '\n');
        return;
      }
      socket.end(JSON.stringify(snapshot()) + '\n');
    });
  });

  return {
    snapshot,
    async start() {
      await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', done);
      });
      try {
        await new Promise((done, reject) => {
          control.once('error', reject);
          control.listen(controlSocket, done);
        });
        await chmod(controlSocket, 0o600);
        listening = true;
      } catch (error) {
        await new Promise((done) => server.close(done));
        throw error;
      }
      return server.address().port;
    },
    async close() {
      resume();
      if (!listening) return;
      listening = false;
      await Promise.all([
        new Promise((done) => server.close(done)),
        new Promise((done) => control.close(done)),
      ]);
      await unlink(controlSocket).catch(() => undefined);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).flatMap((item, index, all) =>
    item.startsWith('--') ? [[item.slice(2), all[index + 1]]] : []));
  const gate = createIngressGate({
    listenPort: Number(args.listen), upstreamPort: Number(args.upstream),
    controlSocket: args.control,
  });
  gate.start().then((port) => console.log(`Synrex stable loopback ingress listening on ${port}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
  const shutdown = () => void gate.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
