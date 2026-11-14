# Synrex v0.4.0 — post-release acceptance and unresolved host boundaries

Evidence date: 2026-11-15 (UTC+08:00). This is an **acceptance
record**, not evidence that every optional peer has been upgraded.
Published v0.4.0 source/tag and active swy1 Owner Core/Console are
`692a77cabdccdaf3b5abe1788a5bbde87a8a9c9c`.

## Verified native packaging

- A native two-OS GitHub Actions qualification passed for
  **Windows and macOS** at
  https://github.com/yuezhihuafou/synrex/actions/runs/43622605441 .
  It checked out the immutable `v0.4.0` tag, installed dependencies,
  typechecked, exercised portable installer/service tests, obtained and
  SHA-256 verified the official public package, installed and activated
  that package to an isolated user prefix and checked packaged entrypoints.
- Archive: `synrex-0.4.0.tgz`, 4,336,153 bytes, SHA-256
  `3339bb19db7d09731a0d51b0f80a375de1b29120e3ece38e701aab7f36c0f2b5`.
- Real Windows laptop: the package was downloaded on swy1, hashed, moved
  over a **temporary** LAN-only file endpoint because direct GitHub archive
  download timed out; it was staged and activated in a separate
  `portable-installer-qa/portable-staged-v04` user directory. The
  native v0.4 CLI doctor returned exit 0 against the existing Windows
  peer config **without modifying or restarting the running peer**.
  The temporary source endpoint had a bounded lifetime, not a standing
  runtime dependency.

## Verified Synrex host-tool behavior (not simulated ChatGPT UI)

- An actual durable command appended a single side-effect record and
  ran a passing Node test. A subsequent read-only `task_wait(final=true)`
  returned the terminal exit 0; the record count was exactly one.
- A checkpointed workflow was resumed by its workflow ID from another
  Synrex workspace invocation. Its original workspace ID, revision,
  constraints, and verification steps survived the handoff.
- An isolated Git coding fixture went from initial passing test to changed
  implementation, then to a deliberately failing assertion (exit 1),
  followed by an input guard fix and a passing test. All temporary
  files were removed after verification.
- These checks demonstrate **the execution substrate and durable workflow
  handoff**, not a forced ordinary ChatGPT conversation/UI disconnect.
  They are not sufficient to claim automatic host-model turn resumption.

## Actual node state and remaining explicit limits

| Host / boundary | Observed evidence | Decision |
| --- | --- | --- |
| swy1 Owner | Active pinned v0.4.0 Core and independently synced Console, public ingress and OAuth verified during v0.4 release | **Production ready** |
| Native macOS test runner | Published v0.4.0 package workflow successful | **Native CI accepted**; no separate owner Mac device deployed |
| Native Windows test runner | Published v0.4.0 package workflow successful | **Native CI accepted** |
| Windows laptop local install | v0.4.0 staged and activated in isolated prefix; CLI doctor on legacy config successful | **Local package accepted**, not the live peer |
| Windows live node | Online but still reports v0.1.0. Its `DevSpace.WinLaptop` scheduled task is `Ready` with a historical nonzero LastTaskResult, while a separate old CLI process is active. | **Do not interrupt** until task ownership, safe migration and rollback from old peer state are independently established |
| gateway | Directory shows offline v0.1.0; from swy1 on registered 192.168.5.9, ARP neighbor fails, ICMP reports host unreachable, SSH times out | **External LAN/host blocker**; not fixable by guessing Synrex node configuration or switching Owner |
| Ordinary ChatGPT app disconnect | No controlled physical UI disconnection or new-chat interruption during a live user engineering task | **Not yet claimed** |

## Safety and next executable gates

1. **Windows live peer cutover** requires evidence of the active old
   process's actual owner, a working restart/supervisor path, a
   consistent backup of the peer's credentials, SQLite and config,
   an executable rollback path, and a one-writer cutover. The
   independently installed v0.4.0 prefix does not imply peer migration.
   Never start an identical peer identity simultaneously or terminate the
   only active remote tool process without verified out-of-band recovery.
2. **gateway rejoin** requires physical/power/switch/cable or host
   network recovery first. After its address is reachable, verify actual
   peer contracts and task ownership; leave swy1 as single public Owner.
3. **Real ChatGPT UI interruption acceptance** requires a new
   conversation/client session or deliberate link interruption, then
   re-reading persisted task IDs, side effects, Git state and checkpoints.
   The host must not silently replay non-idempotent commands.

The earlier 24 local branches, original user worktrees and unrelated
dirty experiments remain preserved. A clean canonical `main` checkout
is not equivalent to production promotion; the release tag and pinned
manifest remain authoritative.
