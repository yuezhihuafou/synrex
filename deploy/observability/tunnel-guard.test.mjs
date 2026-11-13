import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('zero connections: third check proposes restart; cooldown suppresses; recovery clears failures', async () => {
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url === '/metrics') res.end(`cloudflared_tunnel_ha_connections ${connections}\n`);
    else { res.statusCode = 404; res.end(''); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = mkdtempSync(path.join(tmpdir(), 'synrex-tunnel-guard-'));
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./tunnel-guard.mjs', import.meta.url).pathname, '--dry-run'], {
      env: { ...process.env, SYNREX_TUNNEL_GUARD_STATE: dir,
        SYNREX_TUNNEL_GUARD_METRICS: `http://127.0.0.1:${port}/metrics`,
        SYNREX_TUNNEL_GUARD_INGRESS: `http://127.0.0.1:${port}/`,
        SYNREX_TUNNEL_GUARD_TEST_WAN: 'online' },
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  try {
    await run(); await run();
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'))).failures, 2);
    await run();
    assert.match(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /tunnel_guard_would_restart/);
    connections = 2;
    await run();
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'))).failures, 0);
    // The restart limit also suppresses a simulated repeated outage.
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ failures: 2,
      restarts: [Date.now()], lastRestart: Date.now() }));
    connections = 0;
    await run();
    assert.match(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /tunnel_guard_suppressed/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
