# Synrex P0 — parallel development, ingress continuity and network ownership

**Decision date:** 2026-10-26. **Source of truth:** the actual service, release
manifest, Git commits and test results, not this document's snapshot.

## Objective and constraints

Multiple ordinary ChatGPT conversations may edit different aspects of the same
repository concurrently, including Synrex itself, while robotics/research
conversations rely on swy1's live Synrex MCP. Developing, testing and releasing
Synrex must not casually interrupt other conversations or replay robot actions.

- **swy1** owns the sole public HTTPS MCP/OAuth issuer and production SQLite;
  robot device operations stay bound to their actual swy1 workspace.
- **gateway** is an optional, independently running execution/compute peer,
  **not** the mandatory Synrex development machine. It may take expensive
  build/benchmark/ML tasks when useful; its outage cannot break swy1 local work.
- **Git + independent Worktrees** are code-version authority. Neither a
  conversation, a review snapshot nor a mutable checkout is a released build.
- Reuse existing workspace IDs, durable task/run IDs, workflow checkpoints,
  LearningStore, Console telemetry, systemd, SSH and Cloudflare; do not create a
  second OAuth issuer, orchestration service, task database or autonomous LLM.
- Ordinary code edits do not require approvals or synchronous global locks.
  Only integration commits and production version changes are serialized.
- The Research Harness remains a separate caller, not a Synrex product module.

## Actual baseline, not an instruction to overwrite hosts

At inspection, swy1 production was `20261026-synrex-learning-agy-c148b6a`
with source `c148b6a`, while `origin/main` was `d510ba8` (diverged Git
histories). The independent gateway peer reported `4daea81`; a gateway QA
worktree also contained `4351ab2` with task redelivery/diagnostics changes.
Gateway's mutable checkout had tracked and untracked edits. **Do not reset,
prune or blindly cherry-pick those trees.** A Git review snapshot is not a
verified release. Preserve all unique source changes until reviewed.

The inspected network was:

| Host | Bound address/port | Component | Responsibility |
| --- | --- | --- | --- |
| swy1 | 127.0.0.1:7676 | `devspace.service` | public-authoritative MCP/OAuth Core |
| swy1 | 127.0.0.1:20241 | `cloudflared-devspace.service` | Cloudflare local metrics; public ingress managed separately |
| swy1 | 127.0.0.1:3001/18960 | `memhub.service`/`memhub-core.service` | optional memory |
| swy1 | 127.0.0.1:11435 | `devspace-qwen-tunnel.service` | SSH local forwarding to gateway Qwen |
| gateway | 127.0.0.1:7676 | `devspace.service` | independent peer Core, **not** swy1 production |
| gateway | 127.0.0.1:7678 | `devspace-swy1-lan-tunnel.service` | SSH forward to swy1:7676 |
| gateway | 127.0.0.1:3001 | `memhub-swy1-tunnel.service` | SSH forward to swy1 MemHub |
| gateway | 127.0.0.1:11435 | `devspace-local-operator.service` | local model |
| gateway | 127.0.0.1:1089 | `synrex-agy-socks.service` | optional AGY SOCKS |

The gateway Cloudflare public tunnel is **disabled** while swy1 owns ingress.
Do not disable the working private SSH relay because it looks redundant. Old
benchmark/diagnostic listeners on swy1 (observed 8769, 8771, 8783) must be
identified before retirement, never killed blindly. Cloudflare runs with a
token and its remotely configured ingress mapping was not verified locally.

## P0 implementation and commands

### 0. Inventory all local worktrees and candidate commits

```sh
python3 scripts/synrex-p0.py worktrees --repo . --base origin/main
python3 scripts/synrex-p0.py integration-plan --repo . --base origin/main --candidate HEAD
```

Run inventory independently on each peer or from its own workspace; the CLI
does **not** guess that the same path on different hosts is the same checkout.
The report flags non-pruned untracked edits, detached commits and divergence.
`integration-plan` uses merge bases and changed-path overlap as conservative
**review hints**, not as proof of a textual/semantic conflict; no cherry-picks
or pushes are performed. When planning cross-host work, first make its exact
Git object reachable through a deliberately reviewed transfer, not SSH-copy a
dirty working directory. Never clean up all inactive Worktrees merely to make
the report look green.

### 1. Observe local network ownership and active production tasks

```sh
python3 scripts/synrex-p0.py network --node swy1 --probe
# On gateway, against a matching checked-out copy of this source:
python3 scripts/synrex-p0.py network --node gateway --probe
python3 scripts/synrex-p0.py release-check --node swy1
```

`config/ops/network-topology.json` records **expected** port owners, tunnel
edges and critical production services. The CLI compares user-systemd state,
listening IP:port, process cgroup owner and optional local loopback HTTP
health. It flags unexpectedly wide binds, missing ports, unexpected services,
static port conflicts and unknown states. Remote Cloudflare ingress and the
actual ChatGPT client connection must be checked separately. Never log Tunnel
tokens, OAuth credentials or request bodies. Additional QA listeners should
use ephemeral loopback ports rather than permanent global assignments.

`release-check` blocks a **known-busy** `devspace.service` restart if there are
live durable-task units or a failed production Core/public Tunnel. Optional
Qwen/MemHub service health is diagnostic, not a mandatory release gate. This
tool **cannot measure ordinary in-flight MCP requests** on the 2026-10-26
running Core and must not claim zero-interruption safety.

### 2. Serialize privileged release activation

`deploy/activate-owner-release.sh` now takes a machine-local `flock` in the
owner's state directory and runs the release-check **before** changing the
systemd pinned-release drop-in. A competing ChatGPT release or a known live
task causes exit code `75`, with a read-only JSON preflight receipt. No task
is canceled to make a deployment pass. The original pin and state backup are
preserved. A failed systemd activation explicitly restores the old drop-in and
returns a failure exit code (previously this exit code was unreliable).

These protections only take effect **when this new candidate's activation
script is used**. The currently running pinned Core has not been changed by
an isolated source edit; operator or other scripts invoking `systemctl restart`
directly remain outside this guard.

### 3. Isolate and validate the stable ingress prototype

`scripts/ingress-gate.mjs` is a small optional loopback-only HTTP forwarder
using Node's standard library. In isolated tests it preserves Host, path,
method, request body and response; it has a user-owner UNIX control socket
(`0600`) for `STATUS`, bounded `PAUSE` and `RESUME`. `scripts/ingress-ctl.mjs`
is the read-only/status and guarded pause/resume CLI client. When an actual
stable gate is installed and `SYNREX_INGRESS_CONTROL_SOCKET` explicitly points
to it, the release script pauses new requests, checks for zero accepted active
responses before restart, and always resumes after success or rollback. An
unavailable controller blocks a requested controlled cutover before restart.
Without this environment variable, the older ingress path remains in use and
the script reports that active MCP requests cannot be fully observed.
While Core is unavailable, it bounds pending requests and reconnects
**only before dispatch**. It never
automatically retries a request once forwarded to Core, because a lost
response does not prove the tool had no side effects.

The Core now supports a process-local SYNREX_CORE_LISTEN_PORT=7677 override
only on loopback with an explicit HTTPS public OAuth issuer. It relocates the
private listener without changing the persisted OAuth address or credentials.
The stable layout assigns :7676 to synrex-ingress.service and :7677 to
devspace.service; see deploy/systemd/synrex-ingress.service.template.
In stable mode, independently running durable task units survive Core
restart; new MCP requests pause and accepted HTTP requests must drain.
In legacy mode, known live tasks still block direct restart.

**The first swy1 cutover was completed on 2026-10-26.** The original
Core now listens on :7677 and the independent stable ingress owns :7676.
The steps below remain the required procedure for another host or recovery,
not instructions to repeat the first cutover on swy1.

1. Verify the Cloudflare remote ingress mapping and current service owner.
2. Run the ingress on disposable QA ports against a fresh isolated Core/OAuth
   state; compare GET, authenticated POST, streaming, cancellation and refresh.
   The isolated scripts/probe-stable-ingress.mjs test verifies live Core
   relocation, OAuth identity, Console cookies and queued requests on restart.
3. Prove a bounded pause/drain/switch/resume/rollback flow and prevent two
   independent Core processes from writing the owner SQLite/OAuth state.
4. Arrange the **one-time** public `:7676` ownership cutover from Core to
   stable ingress. This cutover itself may cause a short interruption; do not
   market it as zero downtime without observing actual ChatGPT clients.
   The guarded one-time procedure is
   `deploy/migrate-stable-ingress.sh <immutable-release> <backup-dir>`,
   launched in an independent user systemd transient unit, NOT from the
   Core process being restarted. It snapshots the previous pinned drop-in,
   verifies the existing Cloudflare/Core services, waits for initiating MCP
   requests to finish, moves the Core to :7677, starts the ingress on :7676,
   verifies public OAuth identity and topology, and only then enables the
   ingress at boot. A failed handoff stops the gate and restores the previous
   drop-in/Core at :7676. Its JSON receipt and QA evidence are placed in the
   private backup directory. The first handoff has a short unavoidable gap.
5. For subsequent releases, check active requests and preserve task IDs,
   waiting only a bounded period. If a Core exits mid-request, return an
   explicit unknown outcome and recover from saved run receipts, never replay
   a shell write or physical robot action blindly.

This controller handshake is tested with the local fake Core and mocked
activation logic, **not** deployed to the public swy1 endpoint. Verify the
one-time ingress port cutover, exact systemd environment and authenticated
client behavior before relying on it. Socket permissions are one layer of
local owner authority; they do not replace production OAuth.

After a successful one-time cutover, `activate-owner-release.sh`
automatically detects the running ingress unit and its owner-local control
socket. It will not accidentally revert to the legacy :7676 Core bind.
Independent systemd durable task units are not grounds to block a safe
stable-ingress Core upgrade; accepted HTTP requests must still drain within
the bounded admission window. A failed drain cancels the upgrade rather
than terminating ongoing tools or robot actions.

**2026-10-26 canonical version protection:** Production had reached
`e9114fb` while `origin/main` was still `9438b6b` (two Console usage
commits ahead). This is a normal fast-forward opportunity, *not* permission
to downgrade production with an older candidate. The release authority now
calls `scripts/synrex-release-provenance.py` twice (before admission control
and again after draining). It verifies the immutable candidate's manifest,
dist build identity and asset SHA-256 hashes, that its source revision equals
the **latest remote canonical main**, and that it descends from the **actual
running production revision**. Any other branch advancing during a build or
drain causes a refusal, not a forced overwrite. Other conversations can keep
working; only the actual integration/publish and Core promotion are
serialized. A private release receipt records activation or rollback.

The Git Worktree default remains normal `HEAD` for arbitrary projects.
For Synrex itself, new integration worktrees must explicitly start from the
**fetched origin/main**; never use a stale mutable checkout HEAD as proof of
the latest source. Changes from dirty gateway/other WTs must be selected and
reviewed, not automatically swept into production.

### One-command recurring production promotion

Once *selected and tested* changes have been committed and pushed to canonical
`main`, use its clean checkout (including a detached worktree checked out at
the exact published SHA):

```sh
bash deploy/promote-main.sh --check .
bash deploy/promote-main.sh --deploy .
```

The command refuses dirty source, a noncanonical remote, stale `HEAD`, a
commit that does not contain the running production source, or a candidate
with missing/changed immutable build assets. It runs the project build,
supported regression tests and isolated OAuth/MCP/Console ingress checks
before creating an immutable release under
`/home/swy/services/devspace/releases/synrex-main-<SHA>`.
The `--check` result is reusable: `--deploy` validates the same immutable
package instead of rebuilding or overwriting it.

Production promotion then backs up the authoritative OAuth/SQLite state and
dispatches an independent **user systemd unit**, so terminating the launching
MCP call cannot silently truncate the rollback script. That script takes a
release lock, verifies the GitHub `main` SHA **again** immediately before
changing Core, and pauses/drains the stable ingress for a bounded period.
The Cloudflare Tunnel stays alive; detached systemd task units remain
independent. A bad startup, public OAuth failure, later GitHub push during
drain, or exhausted drain window refuses or reverses the switch. The
per-release private directory records a receipt and preflight evidence.

This is a **Core release protocol, not automatic promotion of every dirty
worktree**. A newly pushed main is not secretly deployed. The owner starts
the command when desired; other conversations keep coding. A publish that
races the release causes a safe refusal, after which the newer main is built
and promoted instead. Tests cannot guarantee that an external ChatGPT client
resumes reasoning after a pre-existing network failure.

Subsequent Core upgrades need bounded admission drain. To avoid a permanent
block from idle, long-lived SSE **GET** notification subscriptions, the
ingress closes only these read-only streams with an SSE reconnect comment
before restarting Core. It **never** closes or retries a streaming POST/tool
request; an unfinished POST remains a bounded release blocker, not a reason
to cancel robot execution. Clients might briefly reconnect their GET stream;
HTTP continuity does not prove lossless replay of unacknowledged notifications.
The stable ingress remains running throughout ordinary Core deployment.

### Truncated upstream streams must never permanently block rollout

On 2026-10-26 a source-controlled main promotion refused to restart Core:
the ingress counted five outstanding HTTP streams, although recent Core
diagnostics did not show five unfinished tool calls. One possible mechanism
was confirmed in the source: a server-side upstream `IncomingMessage` abort
could leave the downstream proxy response open indefinitely. The ingress now
closes truncated responses, deletes their active counts, and never retries a
possibly side-effecting POST. Its STATUS response exposes bounded method,
route category, response category and age only; no request path, query string,
header, payload or credential is recorded. Dedicated tests simulate a
half-written SSE stream and assert that the connection and activity count
both terminate.

Upgrading the *stable ingress code itself* is exceptional, not part of routine
Core deployments. `deploy/request-ingress-upgrade.sh <verified-main-release>`
starts an independent user-systemd job with a pinned unit backup, preflight
source checks, health and public OAuth checks and automatic old-unit recovery.
It keeps the Core and Cloudflare untouched. **This one-time proxy upgrade can
interrupt already-open HTTP streams.** Afterward the proxy remains pinned
and continuously running for ordinary Core updates.

### Explicit rollback to the previous verified production release

The existing activation routine automatically restores the old Core if a
deployment fails, but a healthy-looking release can still have a functional
regression. `bash deploy/request-owner-rollback.sh --previous` launches a
detached user-systemd rollback that selects only the current release's
*recorded* `previousRelease` immutable sibling. Its manifest, build identity
and file hashes must match, and the previous Core must support :7677.
The same release lock, bounded ingress drain, health/OAuth checks, preserved
task units and rollback receipt apply. This is an intentional operator
exception to the normal no-downgrade policy; no arbitrary branch or mutable
checkout can be promoted through it. A failed rollback restores the original
Core and records the failure rather than making the public Tunnel a second
runtime owner.

## P0 acceptance and remaining work

| Scenario | Required evidence | Current status |
| --- | --- | --- |
| Concurrent Console/Mem/Subagent development | 3 independent Worktrees, no overwritten dirty files, selected commits integrated once | inventory and static integration plan implemented; full convergence pending |
| Concurrent release requests | second operation refused without modifying unit/drop-in | isolated mocked systemd test |
| Upgrade during durable robot simulation | task remains a separate systemd unit, ID and run receipt survive Core restart | stable-mode guard implemented; repeated real-client release test required |
| Stable ingress handoff | no failures for new requests during bounded planned restart, active requests drain, single writer | first swy1 cutover completed; Core port :7677 / ingress :7676 live, subsequent Core upgrade test required |
| Cloudflare/SSH/GPU peer | swy1 works with gateway offline; no duplicate public OAuth, no port conflict | live inventory partial; fault injection pending |
| Console observability | actual process/port/tunnel + request/task/run causal timeline, unknowns labeled | core historical diagnostics exist; P0 inventory not yet wired to UI |
| LayerFS | meaningful measured advantage versus Git Worktree | deliberately deferred |

### Test commands

```sh
python3 -m unittest discover -s tests -p 'test_synrex_p0.py' -v
python3 -m unittest discover -s tests -p 'test_activate_owner_release.py' -v
node --test scripts/ingress-gate.test.mjs
node scripts/probe-stable-ingress.mjs .
python3 -m unittest discover -s tests -p 'test_migrate_stable_ingress.py' -v
python3 -m unittest discover -s tests -p 'test_release_provenance.py' -v
pnpm typecheck && pnpm build
```

**Promotion rule:** no public Tunnel/port migration, OAuth migration or swy1
restart solely because these source and QA tests pass. First reconcile the
canonical `main` versus the actual pinned production source and the retained
gateway unique commits, preserve the owner-state backup, and exercise the
actual authenticated MCP host path. A Git push and a deployment are distinct.
