#!/usr/bin/env node
// One-shot, bounded Cloudflare connection watchdog. Never touches MCP/OAuth.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

const stateDir = process.env.SYNREX_TUNNEL_GUARD_STATE || path.join(process.env.HOME || '/tmp', '.local/share/synrex-observability/tunnel-guard');
const metricUrl = process.env.SYNREX_TUNNEL_GUARD_METRICS || 'http://127.0.0.1:20241/metrics';
const ingressUrl = process.env.SYNREX_TUNNEL_GUARD_INGRESS || 'http://127.0.0.1:7676/';
const dryRun = process.argv.includes('--dry-run');
const stateFile = path.join(stateDir, 'state.json');
const logFile = path.join(stateDir, 'events.jsonl');
const now = Date.now();
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

function emit(event, detail = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n';
  try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
    appendFileSync(logFile, line, { mode: 0o600 });
  } catch { /* observer must not interrupt services */ }
}
function load() {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); }
  catch { return { failures: 0, restarts: [], lastRestart: 0 }; }
}
function save(s) {
  const temp = stateFile + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(s), { mode: 0o600 });
  renameSync(temp, stateFile);
}
function fetchStatus(url, secure = false) {
  return new Promise(resolve => {
    const req = (secure ? httpsRequest : get)(url, { timeout: 3000, ...(secure ? { method: 'HEAD' } : {}) }, res => {
      let body = '';
      res.on('data', b => { if (body.length < 300000) body += String(b).slice(0, 300000 - body.length); });
      res.on('end', () => resolve({ code: res.statusCode, body }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (secure) req.end();
  });
}
const state = load();
state.restarts = (state.restarts || []).filter(t => now - t < 3600000);
const [metrics, ingress] = await Promise.all([fetchStatus(metricUrl), fetchStatus(ingressUrl)]);
const match = metrics?.code === 200 && metrics.body.match(/^cloudflared_tunnel_ha_connections\s+(\d+(?:\.\d+)?)\s*$/m);
const connections = match ? Number(match[1]) : null;
// 401/404 on root is expected; a TCP/HTTP response establishes local ingress liveness.
const ingressUp = ingress !== null && ingress.code >= 100 && ingress.code < 600;
if (!ingressUp || connections === null) {
  state.failures = 0; save(state);
  emit('tunnel_guard_degraded', { reason: !ingressUp ? 'ingress_unavailable' : 'metrics_unavailable' });
  process.exit(0);
}
if (connections > 0) {
  if (state.outageSince) emit('tunnel_guard_recovered', { connections, outageSince: state.outageSince,
    durationMs: Math.max(0, now - Date.parse(state.outageSince)) });
  emit('tunnel_guard_sample', { connections });
  state.failures = 0; save(state);
  delete state.outageSince;
  save(state);
  process.exit(0);
}
state.outageSince ||= new Date(now).toISOString();
// A local-only signal must not trigger restarts while the machine has no WAN.
const internet = process.env.SYNREX_TUNNEL_GUARD_TEST_WAN === 'online' && dryRun
  ? { code: 200 } : await fetchStatus('https://api.cloudflare.com', true);
if (!internet) {
  state.failures = 0; save(state);
  emit('tunnel_guard_degraded', { reason: 'wan_unreachable' });
  process.exit(0);
}
state.failures += 1;
if (state.failures < 3) {
  save(state); emit('tunnel_guard_failure', { failures: state.failures, connections });
  process.exit(0);
}
if (now - (state.lastRestart || 0) < 600000 || state.restarts.length >= 3) {
  save(state); emit('tunnel_guard_suppressed', { reason: state.restarts.length >= 3 ? 'hourly_limit' : 'cooldown' });
  process.exit(0);
}
if (dryRun) {
  save(state); emit('tunnel_guard_would_restart', { failures: state.failures });
  process.exit(0);
}
// Count attempted restarts, not just successful restarts, to bound repeated failures.
state.lastRestart = now;
state.restarts.push(now);
state.failures = 0;
save(state);
try {
  execFileSync('systemctl', ['--user', 'restart', 'cloudflared-devspace.service'], { timeout: 20000, stdio: 'ignore' });
  emit('tunnel_guard_restart', { reason: 'zero_connections_after_three_checks' });
} catch {
  emit('tunnel_guard_restart_failed');
}
save(state);
