# Synrex: product boundary and delivery roadmap

## Product identity

**Synrex is a standalone GPT-led remote coding and execution platform.** It exposes
workspace-aware code tools, durable commands, workflow state, project memory,
architecture governance, multi-host routing, and a management console. An
ordinary ChatGPT conversation is the default reasoning host; Synrex does not
secretly invoke a paid/CLI agent to emulate subscription-backed reasoning.

**Research Harness is a separate project**, not a Synrex mode, plugin, component,
release milestone, or deployment dependency. It may use Synrex's generic execution
tools through MCP. Robotics experiments, hypotheses, simulations, datasets and
paper generation belong to Research Harness or their respective research
repositories, never to the Synrex core roadmap.

## Interaction surfaces

1. **GPT conversation:** primary place to ask for and supervise coding, editing,
   testing, debugging, and recovery. Synrex provides tools, not replacement
   reasoning.
2. **Synrex Web Console:** independent browser management UI, inspired by the
   *manageability* of memory tools such as MemHub, without cloning their
   architecture. It must work even when no GPT conversation is open.
3. **CLI/MCP:** stable machine-facing and compatibility interfaces to the same
   underlying state and execution engines, not parallel implementations.

Synrex already contains React/Vite-based MCP App cards for workspace and change
review. These are **not** a standalone browser Console. Reuse build tooling,
design tokens, view models and safe utilities where sensible, but keep the
host-embedded cards and management application as independent entrypoints.

## Revised execution order

### R0. Reproducible baseline and product boundaries (must precede releases)

- Reconcile the currently dirty checkout and pinned production release without
  deleting existing user work, commit or otherwise freeze an auditable source
  baseline, and attach source/build/test identities to each release.
- Remove contradictory live-deploy instructions; keep the swy1 single-owner
  OAuth service, existing SQLite state, backup and rollback procedures.
- Keep Research Harness out of Synrex's feature inventory and instructions.

### R1. Reliable GPT coding (main path)

- Prove the actual ChatGPT six-tool fallback and discoverability of the modern
  tool surface (16 tools in the pinned production build; 17 with candidate
  task_wait). Do not equate a server schema probe with client adoption.
- Reproduce and classify real stalls using bounded diagnostic traces and saved
  task receipts. Favor a **bounded task_wait** or compatible status-wait tool
  over repeated short polls; this is *not* a model wake-up mechanism.
- Verify real disconnect/retry behavior, non-idempotent writes, durable command
  recovery, cancellation, and new-chat continuation.

### UI0. Read-only Synrex Web Console (parallel with R1)

Pages, in MVP order:

1. **Overview:** swy1, gateway, optional Windows reachability, service/backup
   health, current/failed tasks, last meaningful incidents.
2. **Workflows & tasks:** saved objectives, acceptance criteria, checkpoints,
   pending commands, run IDs, terminal status, bounded logs and next action.
3. **Diagnostics:** recent tool/MCP timeline, request/call/task correlation,
   HTTP completion vs early close, explicit unknown-host-state classification.
4. **Nodes & versions:** machine state, capabilities/contract compatibility,
   currently owned workspaces, actual build identity and offline status.
5. **Projects, memory & governance:** verified constraints, architecture drift,
   useful learned candidates and provenance. Never manufacture a knowledge
   graph from unrelated raw tool-event rows.

Initial Console is read-only and does not create shells, expose credentials,
modify OAuth authority or start robot motion. It reads existing stores and
diagnostic snapshots; **no new database or agent runtime is needed**.

Use the existing React 19 / Vite 8 stack and a separate browser entrypoint.
Serve through a dedicated owner-authenticated application surface, with
appropriate secure, HttpOnly, SameSite session cookie, CSRF protection,
rate limiting and HTTPS. Do not expose a privileged JSON API under the
public static `/mcp-app-assets` path. Prefer same-origin API snapshots and,
if justified by measurements, authenticated SSE updates; dashboard events
do not and cannot wake an ordinary GPT model turn.

UI0 acceptance: inspect a live/finished command and its log, restore a saved
workflow's next steps after service restart, distinguish a completed MCP call
from an in-flight/early-closed request, and show a node going offline without
affecting swy1's main work.

### R2. Multi-host resilience

- Preserve swy1 as service owner and default development host.
- Treat gateway as optional GPU/compute peer; Windows is optional.
- Validate capability-contract compatibility rather than matching source
  hashes, task receipt reconciliation after reconnect and safe sticky routing.
- Measure long-poll latency before replacing transport with WebSocket.

### R3. Evidence-based memory and architecture governance

- Reuse `AGENTS.md`, versioned project intent, LearningStore and workflow
  checkpoints. Expose vetted memory and architecture evidence via Console.
- Establish promotion/revalidation/expiration rules for learned procedures and
  protect explicit design-change authorization boundaries.
- Only consider a separate memory service if a controlled workflow benchmark
  shows material benefits.

### UI1. Guarded management actions (after UI0 and R1 security review)

- Explicitly authorized task cancellation, safe retry/status refresh,
  checked node drain/undrain and memory candidate review.
- Every mutating operation needs scope validation, confirmation, idempotency
  or indeterminate-outcome handling, and an audit receipt.
- Production release/rollback remains privileged and separately verified;
  do not implement a broad arbitrary-command terminal in the Console.

## Explicit non-goals

- Bundling Research Harness into Synrex;
- using ChatGPT Work or a hidden Codex/API loop as the primary coding agent;
- claiming MCP notifications can autonomously restart ordinary GPT reasoning;
- rebuilding MemHub, Normify, a cluster orchestrator, or a second task store;
- equating successful unit tests with the full real-client coding experience.

## Release gates

Each milestone must pass: isolated unit/integration tests, real authenticated
MCP exercise, a single pinned reproducible release, verified SQLite/OAuth
backups, rollback test where appropriate, and a real user-facing or browser
acceptance path. A source-only change is not a deployed feature.

## Consolidated engineering plan: 2026-10-20

This section is the implementation-level source of truth for Synrex, synthesizing
the earlier project, reliability, memory, multi-node, UI and release audits.
The order is a dependency order, not a promise to finish every phase in one
deployment. **Work and Research Harness remain outside the product.**

### Audited baseline

| Area | Verified fact | Remaining gate |
| --- | --- | --- |
| GPT coding | Older connected host snapshot has six tools; pinned production has sixteen; source candidate adds task_wait (seventeen) | Verify host refresh or safe six-tool fallback |
| Durable shell | Commands, run logs, task IDs, cancellation and notification implementation exist | Fault-injection and non-idempotent retry safety |
| Workflow recovery | SQLite checkpoints, CAS revisions and idempotent create exist | Real new-chat coding continuation |
| Diagnostics | Owner-only rotating 2 MiB timeline and read-only CLI are in production | Diagnose the next actual stuck conversation |
| swy1 | Dedicated single-owner ingress, health timer and verified backup timer are active | Stable source-to-binary release identity |
| gateway | Compute peer, currently connected with smaller tool-contract surface | Restart/reconnect and duration/RTT comparison |
| Windows | Registered optional peer, currently offline | Optional WSL/Windows rejoin and native-path smoke test |
| Learning | Execution episodes are persisted, but useful promoted candidates are not established | Verified extraction and recall benchmark |
| Governance | Versioned architecture and deterministic checks exist | Protected approval boundary and correct default review gate |
| UI | MCP tool cards already use React/Vite | Browser Console and live data/auth acceptance |

### One coherent architecture

```text
   ordinary ChatGPT conversation     Synrex Web Console
           coding authority          owner management/read-only first
                    \               /
                  swy1 Synrex Core
           MCP/OAuth | Console auth
           workspace | SQLite state
           durable runners | diagnostics
           governance | learning
                     |
             compatible peer RPC
                  /       \
          gateway GPU   Windows optional
```

The execution owner remains the relevant peer. Neither Web Console nor swy1
coordinator should duplicate that node's filesystem, Git or durable process
state. Do not infer global workflow equivalence from identical checkout paths
on different nodes.

### Cross-cutting quality bars

1. **Correctness before convenience.** Workflow IDs, workspace owners, task
   IDs, command receipts and Git revisions must remain distinguishable. Never
   call an index entry an active process.
2. **Reliability before automation.** Only replay operations whose effect is
   provably idempotent. Uncertain edits require source inspection; preserve an
   explicit indeterminate result when a node dies between write and receipt.
3. **Debuggability.** Every request boundary needs correlation IDs, a terminal
   or stalled state, and minimally sufficient private logs. No command bodies,
   tokens, OAuth codes or proprietary source in Console diagnostic records.
4. **Small product core.** GPT directs the coding loop; no hidden paid API
   orchestrator, no Work dependency, no mandatory MemHub/Normify, no extra
   task-store copy, and no second frontend framework.
5. **Approval for privileged changes.** Read-only Console first. Any later
   cancel/retry/node/release operation requires explicit user intent, CSRF
   defense, owner authorization, audit and safe retries.
6. **Measured performance.** Track task-success, retry/recovery correctness,
   p50/p95 request RTT, cross-node wait cost, context/tool overhead, and
   verification-to-delivery latency. Do not optimize hypothetical bottlenecks.

### Delivery milestones and acceptance evidence

**M0: provenance and release discipline (blocking all later promotions)**

- Inventory existing uncommitted files and protect or integrate meaningful
  changes. Do not discard them to obtain a clean status.
- Align AGENTS and documentation to pinned owner releases; forbid mutable
  checkout deploy overwrites.
- Produce one reproducible source revision plus immutable artifacts, manifest,
  actual tool-schema fingerprint, compatibility matrix, tested recovery point
  and rollback script.
- Source preflight `pnpm release:source-check` now rejects uncommitted
  work, mismatched source revisions/fingerprints or missing assets; unsafe
  `pnpm deploy:live` is disabled. The current dirty development checkout
  **does not pass the release gate** and is not an eligible source baseline.
- Acceptance: release can be rebuilt from recorded source and has matching
  checksums/tool schema; previous release can be restored without OAuth or
  workflow data loss.

**M1: reliable GPT coding (parallel with UI0)**

- Integrated production candidate: **Completion Mailbox V0** records only new running
  durable command handles, appends bounded completion notices to later
  ordinary MCP tool replies in the same workspace and compatible chat scope,
  and preserves original tool results. The final dependency uses existing
  task_wait(final=true) / six-tool `devspace-task final` with exponential
  backoff advice; after one minute a read-only run-log metadata probe
  activates diagnosis/checkpoint rather than unsafe command replay.
  See `docs/decisions/20261020-completion-mailbox-isolated-experiment.md`.
  Its activation must be confirmed from the actual pinned swy1 service,
  not inferred from an isolated QA instance. Cross-peer push and host
  auto-resume are not claimed.

- Keep the six-tool fallback until actual host refresh is verified. Test
  edit/test/review/fix and resume a substantial change through a new GPT chat.
- Bounded `task_wait` is implemented in the source candidate: it waits up to
  10 seconds without starting or replaying a task and returns a compact
  unchanged receipt on timeout. Compare its invocation count and latency
  against repeated `task_get` calls on real clients before claiming
  improvement. It does *not* wake the GPT host.
- A subsequent source-only optimisation uses local task.json filesystem
  change notifications for immediate read-only wakeups, with jittered
  increasing safety-check intervals when events are lost or unavailable.
  The host-visible tool contract and ten-second maximum remain unchanged.
  See `docs/decisions/20261020-event-driven-execution.md`. The product
  target is explicitly **ordinary ChatGPT conversations, not Work or dots**.
  Next feasibility spike: an optional in-conversation MCP App widget that
  reads job completion, then uses the documented ChatGPT UI
  `sendFollowUpMessage` bridge via an explicit Resume action. Validate
  model/tool continuation and iframe lifetime on a disposable non-mutating
  task before considering opt-in automatic continuation. Do not assume a
  remote domain/proxy or MCP Events can inject ordinary GPT context.
  Generic MCP Tasks notifications are optional only if the actual ordinary
  ChatGPT host supports them. No event push bridge is shipped yet.
- Isolated 2026-10-20 QA has verified a 17-tool authenticated MCP schema,
  preserved workflow and durable task IDs across a candidate restart,
  unchanged OAuth/Console access controls and the new wait path. This is
  **candidate evidence, not proof that the live ChatGPT host refreshed**.
- Inject disconnects around durable task start, tool receipt, patch write,
  cancellation and completion. Check no silent replay.
- Acceptance: three realistic repository tasks complete with saved tests and
  diffs, forced disconnect recoveries do not lose validated work or duplicate
  side effects.

**UI0: Synrex Web Console (now being implemented)**

- Separate React/Vite route `/console` and own authenticated, read-only API.
  The MCP Cards remain a separate ChatGPT-embedded entrypoint.
- Live overview, node compatibility, workflow checkpoints, recent task
  *routing indices*, diagnostic timeline and learning counts. Clearly mark
  unavailable/unknown process state.
- Owner session cookie Secure/HttpOnly/SameSite, bounded login attempts,
  origin checks, strict CSP, output redaction and no browser shell API.
- Acceptance: direct browser login, unauthenticated 401, live data after a
  service restart, all pages responsive, credentials absent from payloads,
  successful pinned packaged QA and rollback-safe release.

**M2: two-Linux-node resilience**

- Keep swy1 independent of gateway; capability negotiation happens per tool
  contract, not per mutable source hash.
- Verify sticky route, journal reconciliation, orphaned completion receipts,
  peer disconnect and rejoin, task owner liveness and no accidental robot
  command fallback.
- A post-M1 source-only compatibility change permits coordinator-side bounded
  task_get polling when an older peer advertises task_get v1 but has no
  task_wait contract. This preserves global task identity, compact receipts,
  and no command replay. Unit-tested, **not part of the currently pinned
  20261020-synrex-m1-v1 production artifact** until a later release.
- Windows is accepted as an optional peer, not a mandatory health gate.
- Acceptance: gateway outage leaves local editing operational; one remote
  long task survives link loss; the returned task owner and run ID remain
  stable after reconnection.

**M3: memory and governance in the existing stores**

- Keep only durable, useful levels: project instructions and hard boundaries,
  decisions/checkpoints, execution evidence, and tested reusable procedures.
- Recall by relevance and source revision; require explicit evidence before
  promoting a learned candidate. Do not let a Git commit alone authorize
  changing protected project architecture.
- Compare outcomes with and without recalled evidence on representative real
  tasks. Only install an external memory service if measured benefit exceeds
  the added operational/latency cost.
- Acceptance: a validated instruction is recalled correctly after a new chat,
  an obsolete one is rejected, architecture drift is reported and no hidden
  self-modifying policy is possible.

**2026-10-21 hardening:** A Git commit is no longer proof of user approval for
architecture intent. The seal advances only when an explicit architecture
change is verified and closed; an unreviewed committed intent remains drift.
An authorized branch switch is recoverable: open an explicit architecture
reconciliation with `architectureChange=true` and a rationale, review its
observed dependency contract, then close it to advance the seal. Ordinary
implementation changes remain blocked until that verification succeeds.
Learning promotion now requires recent successful command-level verification
evidence with a named command appearing in the proposed procedure, and blocks
obvious test/review/authorization bypass instructions. These are narrow
machine-verifiable guardrails, not a proof of semantic correctness and not a
Unix-process sandbox. General-purpose automatic skill induction and
evidence-to-intent semantic checks are still outside the verified milestone.
The read-only `project learn_suggest` action lists repeated successful check
commands and their supporting episode IDs, without creating or promoting
skills. Suggestions are not proof of end-to-end productivity or correctness.

**UI1: guarded owner operations**

- Add task cancel/details, node drain/reconnect and memory candidate
  approval only after each API operation has an explicit audit trail,
  authorization, CSRF protection and idempotent retry policy.
- Releases and raw shell execution stay outside the browser MVP until an
  independent security review and real operator requirement justify them.

### Priority policy

First complete and ship UI0 with a read-only security boundary and a pinned
release, while protecting the current source checkout. Then close the remaining
M0 provenance gap and conduct real-client M1 recovery experiments. M2 and M3
are subsequent capability gates. UI1 is intentionally last. No downstream
milestone blocks ordinary GPT + Synrex coding today.

### UI0 delivery evidence (2026-10-20)

The independent Console entrypoint is now implemented and deployed at
`https://devspace.yuezhihuafou.dpdns.org/console` using the pinned release
`20261020-rev-console-ui0-v1`. Its same-origin, owner-authenticated read-only
snapshot contains service, nodes, workflow checkpoints, recent task *route
indices*, bounded diagnostic events, and learning counters. It neither executes
shell commands nor claims remote task indices represent live process state.

The local owner session uses HttpOnly/SameSite=Strict and HTTPS Secure cookies,
an origin-validated JSON login and bounded password attempts. API calls from
unauthenticated clients return 401. The browser app reuses React/Vite already
installed for MCP cards without overwriting their entrypoint.

Verification: TypeScript build, unit tests, full regression, isolated HTTP
MCP/OAuth workflow and durable-task restart recovery, actual owner login
challenge, protected API snapshot, fake cookie rejection, and Chrome headless
rendering all passed. Production owner runtime and OAuth discovery remained
healthy after versioned rollback-safe promotion and state backup.

UI0 was initially deployed in the historical Rev-named release. See the
subsequent Synrex release record below for the current pinned version.
Advanced task/process detail and protected write actions remain deferred.

### M0 source provenance and M1 bounded wait release evidence (2026-10-20)

**M0's source-to-release provenance blocker is closed for the pinned
`20261020-synrex-m1-v1` release.** Its source was snapshotted to Git commit
`6d05d3f24fbbb7d056ed6a64d6393919933637dc`, independently rebuilt with
a frozen offline lockfile, checked as Git-clean, packaged with source archive
and key asset checksums, and successfully promoted after a verified owner
state backup. Production's external MCP/OAuth URL, issuer, database and
legacy CLI compatibility remain unchanged. The previous pinned release and
the activation rollback path are preserved.

The new release exposes 17 compiled tools, including a read-only, bounded
`task_wait` that does not replay commands or resume GPT model inference.
Isolated authenticated HTTP/MCP QA verified tool-schema fingerprint
`c9dfa18943863a1d5653`, workflow and durable-command recovery after
restart, and Console security controls. A full regression run passed 272
tests with 0 failures and 1 explicitly skipped test.

**Remaining M1 gate:** actual new ChatGPT-host tool-list refresh is not yet
proven. Live enrollment remains locked, so the production schema probe could
verify compiled identity but not create a new authenticated probing client.
Real-model task success, polling cost, and ambiguous non-idempotent remote
write fault injection are still pending. The cross-node resilience and
evidence-backed memory acceptance milestones also remain open.

Full rollout evidence and precise limitations:
[`docs/release-evidence/20261020-synrex-m1-v1.md`](release-evidence/20261020-synrex-m1-v1.md).

### 2026-10-21: V1.0 acceptance and implementation handoff

This earlier roadmap contains historical candidate/release observations.
The subsequently pinned owner and gateway production release is
`20261021-synrex-reliability-v3` (manifest source `d9b576b`).
The active, evidence-first V1.0 work and outstanding comparisons are tracked
in [`SYNREX_V1_EXECUTION.md`](SYNREX_V1_EXECUTION.md). Do not confuse its
source-only changes or component benchmarks with deployed end-to-end wins.
