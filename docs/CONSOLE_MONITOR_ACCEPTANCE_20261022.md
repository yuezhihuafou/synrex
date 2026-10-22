# Console P0–P2 acceptance, 2026-10-22

## Installed result

- Additive source branch: `console-monitor-p012`; runtime source commit `9335c1a`.
- Pinned monitor release: `/home/swy/services/synrex-console/releases/20261022-p012-9335c1a`.
- Independent user unit: `synrex-console.service`, enabled; port 4318.
- Verified LAN browser entry: `http://192.168.5.148:4318/console/`.
- Existing Owner login; own signed HTTP-only browser session.
- Production state/runs observed; monitor SQLite is separate under
  `/home/swy/.local/share/synrex-console-monitor/`.
- Explicit cancellable roots: `/home/swy/DevSpace` and the isolated console
  worktree. No production task was cancelled during acceptance.
- Old experimental monitor/QA units and temporary tunnel stopped. The quick
  tunnel returned an external 403 and is not a delivered or verified public URL.
- Existing production `/console` and MCP release were not replaced by this work.

## Checks

- Focused Node tests: 10/10, exit 0, including real detached-task cancellation,
  authenticated HTTP/SSE and patches, forbidden-origin actions, output bounds,
  symlink rejection, trace rotation/restart/deduplication, and additive full-chain
  event sanitation/stage statistics. Run `run_20261022085000_620c75eb`.
- TypeScript: `tsc -p tsconfig.json --noEmit`, exit 0,
  task `task_7dc69f7113724e86` / run `run_20261022085003_81bf88df`.
- Both browser and standalone-server Vite bundles built successfully.
- Final packaged server on isolated port 4320: 9 browser checks passed;
  run `run_20261022085113_7f49b998`.
- Installed LAN path: 9 browser checks passed, including login, live SSE, all
  navigation pages, output/detail panel and 390px mobile no-overflow layout;
  run `run_20261022085217_d920e4c3`.
- Real full-chain statistics were returned for auth, task_launch,
  task_initial_wait, tool_handler, learning, mailbox, mcp_dispatch and routing;
  487 observed requests in the queried retained one-hour window at acceptance.
  Run `run_20261022085256_56c8f077`.

## Measured lightweight overhead

Final installed unit; 30.038 seconds, one SSE viewer plus 12 snapshot requests.
The measurement includes a temporary headless browser exercising the same console
near the start. Cgroup metrics cover the console, not the headless browser.

| Measurement | Observed |
| --- | ---: |
| Console CPU time | 269.031 ms |
| Average CPU, one-core basis | 0.89565% |
| Cgroup memory | 47,341,568 bytes (45.15 MiB) |
| HTTP snapshot P50 / P95 | 1.972 / 3.447 ms |
| Collector sample P50 / P95 | 299 / 601 ms |
| Largest snapshot | 127,747 bytes |
| SSE bytes over measured window | 315,039 bytes |
| Console restart count | 0 |

Source: `scripts/console-monitor-probe.ts`, task `task_14e76324ed48437d`,
run `run_20261022085221_d95c417f`. These are short-window measurements, not a
long-running reliability guarantee or a measure of ChatGPT model latency.
An earlier unoptimized snapshot was 520,530 bytes; the final payload reduction
is about 75.5%, with delta events between full initial snapshots.

## Production isolation and remaining scope

This work only added files in an isolated Git worktree. The working checkout was
clean when rechecked. Another operation updated the main working HEAD and
production service during this session: final observed production PID 3983827,
activation time 2026-10-22 16:20:34 Asia/Shanghai, NRestarts=0. This console work
did not invoke production activation/restart; its log adapter was updated to
read the newer additive event contract.

Remote node directory/status is visible, but remote CPU/GPU/process collectors
are not installed. Interactive/PTY session termination is unavailable without
a core adapter; their visible OS processes are read-only. Cancellation is for
verified local durable tasks in explicitly configured exact workspaces. There
is no arbitrary-command endpoint, general PID-kill button or automatic retry.

Stopping `systemctl --user stop synrex-console.service` stops this console only.
The monitor can be removed or rolled back without touching `devspace.service`.
