import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const allowed = new Set(['tunnel_guard_failure', 'tunnel_guard_degraded', 'tunnel_guard_recovered',
  'tunnel_guard_restart', 'tunnel_guard_restart_failed', 'tunnel_guard_suppressed', 'tunnel_guard_sample']);
export type TunnelRecoveryEvent = { ts: string; event: string; reason?: string; failures?: number; connections?: number };
export type TunnelRecoverySummary = {
  available: boolean; sampledAt: string | null; windowHours: number;
  activeConnections: number | null; healthySampleAt: string | null;
  failures: number; restarts: number; restartFailures: number; recoveries: number;
  totalDowntimeMs: number; ongoingSince: string | null;
  incidents: Array<{ startedAt: string; endedAt: string | null; durationMs: number | null; restarts: number }>;
  events: TunnelRecoveryEvent[];
};

// Fixed, local, allowlisted paths; never accept a client-controlled file path.
export function readTunnelRecovery(directory = path.join(homedir(), '.local/share/synrex-observability/tunnel-guard'), now = Date.now()): TunnelRecoverySummary {
  const files = ['events.jsonl.1', 'events.jsonl'];
  const cutoff = now - 7 * 86400_000;
  const events: TunnelRecoveryEvent[] = [];
  let available = false;
  for (const name of files) {
    const filename = path.join(directory, name);
    if (!existsSync(filename)) continue;
    try {
      const source = readFileSync(filename);
      available = true;
      // Read a bounded tail; don't parse partial first lines from truncated files.
      const bounded = source.length > 2 * 1024 * 1024 ? source.subarray(source.length - 2 * 1024 * 1024) : source;
      for (const line of bounded.toString('utf8').split('\n').slice(source.length > bounded.length ? 1 : 0)) {
        try {
          const item = JSON.parse(line);
          const time = Date.parse(item.ts);
          if (!allowed.has(item.event) || !Number.isFinite(time) || time < cutoff || time > now + 30000) continue;
          events.push({ ts: new Date(time).toISOString(), event: item.event,
            ...(typeof item.reason === 'string' ? {reason: item.reason.slice(0, 90)} : {}),
            ...(Number.isInteger(item.failures) ? {failures: item.failures} : {}),
            ...(Number.isFinite(item.connections) ? {connections: item.connections} : {}) });
        } catch { /* Ignore malformed or partially rotated lines. */ }
      }
    } catch { /* Optional diagnostic source; leave Console available. */ }
  }
  events.sort((a,b) => a.ts.localeCompare(b.ts));
  const unique = events.filter((e,i) => i === 0 || e.ts !== events[i-1].ts || e.event !== events[i-1].event);
  const incidents: TunnelRecoverySummary['incidents'] = [];
  let current: (typeof incidents)[number] | null = null;
  for (const e of unique) {
    if (e.event === 'tunnel_guard_failure' && !current) {
      current = {startedAt: e.ts, endedAt: null, durationMs: null, restarts: 0};
      incidents.push(current);
    }
    if (e.event === 'tunnel_guard_restart' || e.event === 'tunnel_guard_restart_failed') {
      if (!current) { current = {startedAt: e.ts, endedAt: null, durationMs: null, restarts: 0}; incidents.push(current); }
      current.restarts++;
    }
    if (e.event === 'tunnel_guard_recovered' && current) {
      current.endedAt = e.ts;
      current.durationMs = Math.max(0, Date.parse(e.ts) - Date.parse(current.startedAt));
      current = null;
    }
  }
  const recent = unique.filter(e => Date.parse(e.ts) >= now - 86400_000);
  const healthy = [...unique].reverse().find(e => e.event === 'tunnel_guard_sample' && typeof e.connections === 'number');
  return { available, sampledAt: unique.at(-1)?.ts ?? null, windowHours: 24,
    activeConnections: healthy?.connections ?? null, healthySampleAt: healthy?.ts ?? null,
    failures: recent.filter(e => e.event === 'tunnel_guard_failure' || e.event === 'tunnel_guard_degraded').length,
    restarts: recent.filter(e => e.event === 'tunnel_guard_restart').length,
    restartFailures: recent.filter(e => e.event === 'tunnel_guard_restart_failed').length,
    recoveries: recent.filter(e => e.event === 'tunnel_guard_recovered').length,
    totalDowntimeMs: incidents.filter(i => i.durationMs !== null && Date.parse(i.endedAt!) >= now - 86400_000)
      .reduce((total,i) => total + i.durationMs!, 0),
    ongoingSince: current?.startedAt ?? null,
    incidents: incidents.slice(-30).reverse(), events: unique.filter(e => e.event !== 'tunnel_guard_sample').slice(-90).reverse() };
}
