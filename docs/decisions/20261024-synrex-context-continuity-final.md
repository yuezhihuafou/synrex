# ADR: Synrex context continuity and bounded Subagent integration

Status: **gateway isolated implementation candidate**, 2026-10-24.
Authority: `docs/PRODUCT_CHARTER.md`; this ADR describes design and measured
acceptance, not a claim of production delivery.

## Problem and target outcomes

The existing GPT-led Synrex coding loop repeatedly reads repository context,
loses diagnostic details across model/host handoffs, and currently retains only
the last Subagent answer even if a provider returns execution items. MemHub and
Synrex must be allowed to independently upgrade, fail and roll back. Our target
is fewer duplicate reads, fewer retries and higher verified end-to-end
completion, *not* the largest number of agents or services.

## Accepted architecture

1. **GPT stays the decision/interaction host** in ordinary ChatGPT. A bounded
   Gemini/Codex/Pi Subagent is explicitly selected for a particular task;
   Synrex does not secretly start its own autonomous planner or host loop.
2. **Synrex remains a modular core**, not a constellation of microservices.
   Its existing Workflow (CAS checkpoints), Workspace, LocalAgent daemon and
   peer-owned durable tasks remain the only authorities for execution.
3. **MemHub remains an independently deployed optional service**, accessed
   through a read-only Memory Port and a MemHub MCP adapter. No direct MemHub
   database imports, no new mandatory process, no replication of L1-L4.
4. **Task handoff is a generated view**, not a second persistent workflow.
   It contains a bounded goal/next-step/checkpoint summary, fresh Git
   observation, explicit task IDs, and referenced Subagent evidence. A stale
   checkpoint is never proof of current source state.
5. **Agent evidence stays on the execution node** in private append-only
   artifacts, with opaque refs, content digests and a minimal latest index.
   Completed and failed runs both capture evidence. The artifact is not a
   verified test result unless independent checks establish that fact.
6. **Project authority is intentionally separated.** Git and approved
   architecture contracts govern source and intended structure; task receipts
   govern run outcomes; MemHub provides project history and memory evidence.
   A MemHub project's canonical slug does *not* replace a Synrex workspace ID.
7. **Agent approval is distinct from execution containment.** L0/L1 work can
   proceed without repetitive approval; bypassing provider approval does not
   guarantee isolation from backups, databases, or hardware. The existing
   read_only/allowed/full_access semantics remain the contract. No broad
   command blacklist or implicit privileged deployment is introduced.
8. **Existing two-node routing is preserved**: swy1 is public MCP/OAuth owner;
   gateway is a full optional execution peer. An execution artifact's owner is
   its actual peer, not automatically the swy1 coordinator.

## Components and dependency direction

```text
ordinary GPT host
   | (existing MCP tools)
Synrex modular core
   +- CodingWorkflowStore ----> Handoff View (read-only composition)
   +- LocalAgentManager ------> private AgentEvidenceStore
   |     +- provider adapters (Gemini / Codex / Pi)
   +- ProjectMemoryPort ------> optional MemHub MCP adapter ---> MemHub service
   +- existing Workspace / Git / Durable tasks / peer routing / Console
```

The adapter depends on a *small Synrex-defined capability interface*.
MemHub-specific tool names and response fields must not leak into
LocalAgentStore, Workflow or the Git authority.

## MemoryContract v1 (read-only first)

`recall({project, query, maxBytes})` returns either a scoped compact memory
capsule with exact source/evidence refs, or an explicit `unavailable`,
`ambiguous` or `disabled` status. `hydrate(evidenceRef)` reads an exact
revision, never a newly guessed project alias. Project must be an explicit,
registered MemHub identity; if unspecified, no project-scoped recall occurs.
The adapter uses bounded timeouts, no unbounded retry and no hidden writes.

Service unavailability must not block `workflow_status`, Git, source tools
or the LocalAgent daemon. A recall result is optional history, not an
authorization or executable instruction. In v1 there is no automatic
`memmy_turn`, distillation, Skill promotion, or architecture replacement.

## HandoffContract v1

A read-only `workflow_status` view carries workflow revision/goal/constraints,
phase, unfinished steps/blockers, explicit durable-task IDs and agent IDs,
fresh Git head/status and whether they match the checkpoint. Agent IDs refer
to separately persisted private evidence. Include optional bounded MemHub
items *only when requested* and scoped to an explicit project.

There is **no promise** that an Antigravity session can resume across models,
that a remote process can transparently migrate, or that a completed MCP call
can wake ordinary ChatGPT's model after its turn ends.

## Operational boundaries and upgrades

- No new public endpoint, task database, cluster control plane or agent loop.
- Distinct, pinned MemHub and Synrex releases; backward-compatible versioned
  memory output; consumer contract tests against mock and live read-only API.
- If MemHub is down, record a compact unavailable status, do not block
  execution. If an agent result is indeterminate, record that state and do not
  blindly replay an external side effect.
- Evidence files are owner-only (0600), directories 0700, and unavailable
  through unauthenticated HTTP/Console. Explicit hydrate must first enforce
  existing workspace/agent scope.
- Integration and contract test against a disposable gateway workspace.
  **No production deployment** until authorized, with immutable release,
  source provenance, SQLite/OAuth backup, real MCP/Console QA and rollback.

## Delivery plan and acceptance gates

| Phase | Deliverable | Measured gate |
|---|---|---|
| G0 | This ADR + gateway pinned baseline | Unrelated dirty gateway files untouched, source identity recorded |
| G1 | Private Subagent evidence and scoped retrieval | success/failure records, SHA256, restarts, wrong-scope denial |
| G2 | Generated Handoff View from existing workflow | checkpoint CAS unchanged, fresh Git mismatch visible, refs recoverable |
| G3 | Optional MemHub read-only adapter | exact project/ref contract, mock tests, outage/timeout fallback, live read smoke if reachable |
| G4 | Context pack optimization | Git/Serena reuse and duplicate-read metrics; do only after G1-G3 |
| G5 | A/B/C2 × five real engineering tasks × five trials | wall-time, first-pass success, retries, duplicate reads, GPT/Gemini token if measurable; no invented GPT Direct trials |
| G6 | Explicit authorized pinned promotion | no cross-peer source rollback, live schema and service health, recovery/rollback verified |

G0-G3 are the **first executable slice**. Later phases are conditional on
observed benefit and independent release acceptance. Do not conflate a
read-only transport-size pilot with a valid end-to-end architecture comparison.

## Gateway G0-G3 acceptance record (2026-10-24)

**Baseline:** isolated gateway worktree created from pinned
`584be814e68ca79ddc6070cee28c7a1eab7e8ba0` (gateway ROS Bridge
and Antigravity integration). The mutable gateway checkout's 60 pre-existing
changes were not merged, reset or touched. No production activation occurred.

**Implementation:** No additional database, server or external coordinator was
created. `LocalAgentManager` stores private per-run evidence (completed and
failed) and exposes scoped records through the existing Agent Daemon/CLI.
The Workflow status tool produces a versioned handoff from its existing
CAS checkpoint, fresh Git state and explicitly linked Agent refs. MemHub
integration is opt-in via `SYNREX_MEMHUB_URL` plus explicit `memoryProject`
on the existing `workflow_status` request; otherwise the memory port
is disabled. MemHub is never a prerequisite for the coding loop.

**Verification:**

- Gateway TypeScript `tsc --noEmit`: 0 diagnostic errors.
- Focused CLI/Agent/Workflow/MemHub test set: **13/13 passed**, 0 failed.
- Gateway build `pnpm build`: passed; isolated candidate produced frontend,
  server and compiled adapter assets. The worktree build-info was marked dirty
  while the changes remained uncommitted, correctly identifying QA-only
  provenance.
- Isolated authenticated release probe: `qa: passed`, 17 tool contracts,
  schema fingerprint `84319447b33194f65632`, preserved workflow and durable
  task state through restart, duplicate create and checkpoint replay safety,
  completion mailbox, diagnostic correlation and protected Console browser
  rendering. No production OAuth or state files used.
- Real gateway Gemini Antigravity read-only Subagent smoke after Provider
  update: **completed**, `gemini-3.8-flash-medium`, **11018 ms**;
  one observed Provider JSON item stored, private evidence persisted and
  re-opened after manager/store shutdown. This is one real successful test,
  **not** a performance comparison or a full tool-event trace.
- Live swy1 MemHub over **temporary** SSH loopback forwarding: MCP handshake
  and project list succeeded. Deployed MemHub 1.0.0 lacks upstream GitHub
  `memmy_context` optional `detail` and `max_content_bytes` parameters.
  Input schema negotiation resolved the incompatibility; exact scoped
  `Memhub` recall returned `ok`, 2 items bounded to 8 KB.

**Known limitations and next gates:**

- Live MemHub currently advertises only a canonical project `Memhub`; no
  `synrex` project mapping was registered or created. The live recall returned
  **zero exact evidence refs**, so live `hydrate` cannot yet be claimed
  tested (mock contract tests pass).
- Headless Antigravity returns its final Provider JSON, not verified
  tool-by-tool execution events. Its structured evidence explicitly labels
  `toolEventsObserved: false`.
- This slice **does not** implement automatic Context Pack injection into
  Subagents, full read deduplication, model routing, a hardened
  `allowed`-mode OS sandbox, cross-peer process migration, or the 75-run
  A/B/C2 experiment. Those are G4/G5 work conditional on valid measurements.
- No production rollout was requested for this gateway-first isolated
  implementation. A future rollout must build from the latest pinned release
  and independently pass rollback-safe production acceptance.
