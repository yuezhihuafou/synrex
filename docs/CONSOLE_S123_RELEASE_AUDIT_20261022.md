# Console S1-S3 production delivery — 2026-10-22

## Release and isolation

- Implemented in isolated branch `synrex/console-s123-20261022`.
- Shipped source commit `044b72b6a8dca493ea10586c6a23aba3072cbf29`.
- Immutable artifact `/home/swy/services/synrex-console/releases/20261022-s123-044b72b`.
- Live user systemd unit: `synrex-console.service` at port `4318`, Owner auth unchanged.
- Console unit now uses an additive drop-in:
  `~/.config/systemd/user/synrex-console.service.d/30-s123.conf`.
- The original pinned `20261022-p012-9335c1a` release remains available,
  as does the original unit file. Rollback: disable the drop-in, reload the
  user systemd manager, and restart **only** `synrex-console.service`.
- Production MCP remains `devspace.service` on PID `3983827`, NRestarts `0`
  throughout this Console migration. The MCP source and release were not changed.

## Acceptance evidence

- Focused tests: 11/11 passed, run `run_20261022095048_9a467634`.
- TypeScript `tsc --noEmit`: exit 0, run `run_20261022095052_84433861`.
- Vite browser/server bundles: exit 0, run `run_20261022095057_ff3ad41c`.
- Final live browser GUI: 12/12 checks passed, including nonempty selected
  Trace waterfall, SSH gateway resource panel, minute/node breakdown,
  authenticated live SSE, run output and 390px mobile layout;
  run `run_20261022095252_5ae09f6c`.
- Actual remote SSH probe observed gateway CPU/RAM/GPU and 88 user processes.
  It installs no peer service.
- Live monitor SQLite migration had `1503` retained requests and a matching
  `1503` minute-bucket total at the post-activation check.
- Live performance probe `run_20261022095256_71a479bf` covered 30.137s:
  1.297% mean CPU of one core, 57,995,264 bytes (~55.3 MiB) memory,
  HTTP P50/P95 2.34/93.73 ms, collector sample P50/P95 230/1604 ms,
  maximum snapshot 134,787 bytes, zero Console restarts. These are a
  short-window measurement, not a general SLA.

## Migration failure and recovery evidence

- The first attempted release `20261022-s123-30090a9` failed on migration
  from a populated old SQLite monitor database: writing bucket rows while a
  `better-sqlite3` `.iterate()` SELECT cursor remained open yielded
  `TypeError: This database connection is busy executing a query`.
- Its activation script automatically returned to the original Console
  service; core `devspace.service` was unaffected.
- The final fix loads the bounded legacy requests before inserting aggregates.
  Test coverage now includes an explicit populated old-DB upgrade.
- The same migration was replayed on a **separate copy** of the real prior
  production SQLite backup. The independent instance reached HTTP 200 and
  produced 1496 minute requests from 1496 retained rows, without mismatch.
- Preserved consistent original backup:
  `/home/swy/.local/share/synrex-console-monitor/backups/s123-20261022-1749/`.
  No QA database replaced the production monitor database.

## Observable limitations, not silently inferred capabilities

- Interactive/PTY and remote processes are observational; only verified local
  durable tasks support cancellation. No generic PID-kill or shell endpoint.
- Statistics count events the monitor actually observed. Rotated-away raw
  data predating observation cannot be reconstructed. P50/P95 reflects retained
  duration detail; node comparisons count stage samples, not all requests.
- No ChatGPT internal reasoning time, token usage or cost is represented as
  Synrex timing. The full-chain logger is independently developed and only
  consumed through the sanitized event adapter.
- The old LAN HTTP entrypoint and separate legacy `/console` remain outside
  this S1-S3 release. A unified HTTPS console endpoint is separate S0 work.
