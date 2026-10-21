# Synrex V1.0 progress — pinned owner rollout (2026-10-21)

**Status:** Released and verified; **V1.0 end-to-end performance
acceptance remains open**. This milestone fixes three measured quality gaps
without claiming superiority over the original Dev approach.

## Release identity and preservation

| Item | Verified |
| --- | --- |
| Owner | swy1, `devspace.service`; single public MCP/OAuth authority |
| Active immutable release | `/home/swy/services/devspace/releases/20261021-synrex-v1-progress-3974a10` |
| Release source | `3974a10d19e1b50f65d3f29e65093aa5024cc23e` |
| Clean source fingerprint | `8c21ae62253c2a4fc868` |
| Dist files / dist-tree SHA-256 | `429` / `7e801fe14d5522a2a1b303c856cf193345957599ccbdab6064c43dfb913597f1` |
| 17-tool MCP schema fingerprint | `b90cf80b9f85bd3568c5` |
| Previous pinned release | `20261021-synrex-reliability-v3`, preserved |
| Source QA worktree | `/home/swy/services/devspace/build-v1-acceptance-20261021-3974a10` (detached, clean) |
| State backup | `/home/swy/services/devspace/backups/v1-progress-3974a10-owner-precutover/owner-20261021T134815048013Z` |

The preceding `reliability-v3` source was `d9b576b`, not an obsolete QA
snapshot. The package has a pinned release manifest, source-tree archive and
recorded runtime-asset hashes; the same SHA-256 algorithm was checked against
the previous manifest before packaging. Frozen-lockfile offline dependency
installation, clean revision build, source preflight and architecture checks
passed. Production's OAuth issuer, ingress URL, SQLite and compatibility CLI
were not migrated. Gateway's separate dirty development worktree was
preserved.

## Actual verification

- Full source regression: **294 passed, 0 failed, 1 skipped**.
  `pnpm -s test`, run `run_20261021133653_2213588d`.
- TypeScript: `pnpm -s typecheck` passed; architecture validation:
  0 errors, 0 warnings; source release check: `ready=true`, clean and
  recorded build source matches Git.
- Focused regression: 13/13 learning/benchmark tests and 1/1 workflow
  live-Git handoff test. The corresponding failing regression cases were
  observed before their fixes.
- Packaged install smoke: `task_70c149d946eb4d18`, exit 0.
- Disposable **authenticated HTTP MCP/OAuth/Console** candidate QA:
  `task_0094e5c279bb471c` / `run_20261021134341_f06dee8f`, exit 0.
  Confirmed all 17 tools, schema fingerprint, completion mailbox, Final
  Barrier, workflow/durable task recovery after process restart, replay
  safety for workflow creation/checkpoint, protected Console auth and live
  dashboard, bounded diagnostic correlation, Chrome render.
- Owner-state online backup: SQLite `devspace.sqlite` and
  `coding-workflows.sqlite` both independently checked `pragma quick_check=ok`.
- Rollback-ready switch launched outside MCP through systemd transient
  `synrex-v1-progress-3974a10-activate.service`; unit
  `Result=success`, `ExecMainStatus=0`. New owner PID `2676861`;
  `ExecStart` points at the release above.
- Live postflight: localhost `/healthz` 200, public OAuth discovery 200;
  unauthenticated `/mcp` 401, `/console` 200,
  `/console/api/snapshot` 401. In this **actual ordinary ChatGPT host**,
  a call to `workflow_status(wf_d8ec6462633c505e20431c3c)` returned
  new `handoff` fields showing live Git at `3974a10` and
  `checkpointGitMatchesCurrent=false` against the old saved `d9b576b`
  snapshot, as expected.
- gateway and swy1 both remain registered online, 17/17 tool contracts
  compatible; gateway stayed on `reliability-v3` because no worker
  protocol change required a coordinated cutover.
- Earlier gateway live fault injection: a 28-second remote durable command
  `task_b7667e38080a9b1549baf7b320520dd3` survived restarting the
  gateway service (PID `1152753` → `1183883`); run
  `run_20261021132857_174ee09e` completed with exit 0 and
  exactly one start/finish. No write replay was attempted.

## Measured benefit and unverified goals

The fixes prevent detached or failed checks being learned as successes,
flag unpaired model/environment benchmark samples, and surface stale-Git
handoff state in the real MCP client. Governance engine passed 6/6; the
learning/semantic/governance fixture passed 5/5. Cold Serena symbol
find+references cost ~7.6 s versus 2.36 ms text search on a tiny fixture;
this is mechanism overhead, **not** end-to-end GPT task improvement.

**Not yet proven:** controlled same-task, same-model GPT+original Dev versus
GPT+Synrex success rate, median wall time, tool calls, human interventions
or context overhead; an independent brand-new ChatGPT conversation takeover;
network partition and non-idempotent write acknowledgment loss; revision-
scoped production learning re-use versus no recall; release rollback *drill*.
The rollback mechanism and prior binary exist, but this rollout did not
intentionally reverse a healthy production release. Ordinary ChatGPT cannot
be autonomously woken to think after its turn ends by this MCP server.

All remaining V1 acceptance tasks and benchmark schema are maintained in
[`docs/SYNREX_V1_EXECUTION.md`](../SYNREX_V1_EXECUTION.md).
