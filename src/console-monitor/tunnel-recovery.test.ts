import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readTunnelRecovery } from './tunnel-recovery.js';

test('Tunnel recovery duration is counted only after a recovery record', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'synrex-tunnel-summary-'));
  const now = Date.parse('2026-11-11T08:00:00Z');
  const event = (sec:number, name:string) => JSON.stringify({
    ts: new Date(now - 100000 + sec * 1000).toISOString(), event: name });
  try {
    writeFileSync(path.join(dir, 'events.jsonl'), [
      event(0, 'tunnel_guard_failure'), event(60,'tunnel_guard_restart'),
      event(90,'tunnel_guard_recovered'),event(95, 'tunnel_guard_failure'),
      JSON.stringify({ts: new Date(now-2000).toISOString(),event:'tunnel_guard_sample',connections:2}),
      '{malformed', JSON.stringify({ts: new Date(now).toISOString(), event:'unsafe_extra', token:'secret'}),
    ].join('\n'));
    const result = readTunnelRecovery(dir, now);
    assert.equal(result.restarts, 1);
    assert.equal(result.activeConnections, 2);
    assert.equal(result.recoveries, 1);
    assert.equal(result.totalDowntimeMs, 90000);
    assert.equal(result.incidents[0].durationMs, null);
    assert.equal(result.incidents[1].durationMs, 90000);
    assert.equal(result.events.some(x => x.event === 'unsafe_extra'),false);
    assert.equal(result.events.some(x => x.event === 'tunnel_guard_sample'),false);
    assert.equal(result.ongoingSince, new Date(now - 5000).toISOString());
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
