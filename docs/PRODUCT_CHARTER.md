# Synrex Product Charter V0.2

Status: accepted product direction, 2026-10-20. This is the authoritative
product-intent and scope document for future changes. It is **not** a claim that
all described behavior has shipped. `docs/SYNREX_PRODUCT_ROADMAP.md` owns the
implementation milestones and their verification status; actual source, pinned
release manifests, and tests own claims about current behavior.

## Identity and mission

**Mission:** Give conversational AI, with ChatGPT as the primary interaction
host, engineering execution capabilities approaching those of a native coding
agent without replacing the host's reasoning or losing control of the user's
projects. Optimize real task completion, continuity, context efficiency, and
enforceable project boundaries, not the number of exposed features.

**Product category:** GPT-first, model-independent-core coding and execution
harness. Coding is the product's primary use case. Generic execution primitives
can also support simulations, builds, tests, data processing, and other
authorized computational work.

**Primary host boundary:** Synrex is designed for **ordinary ChatGPT
conversation mode**, with GPT as the visible reasoning/decision agent. Do not
make ChatGPT Work, dots, a separately billed model/API agent, or a standalone
chat frontend a requirement for its primary user experience. A ChatGPT MCP App
widget may be an **optional component within the ordinary conversation**,
not a substitute for that conversation. Host-specific follow-up bridges may
only be treated as supported when verified in the actual ordinary-chat host.
No reverse proxy or server event is assumed to have permission to inject
messages into a conversation or resume GPT reasoning without host support.

**Boundary:** Research Harness is a separate application/project. It may call
generic Synrex tools; hypotheses, literature reviews, experiment protocols,
robotics-specific workflows, research data semantics, and paper generation
belong outside this product's core and release roadmap. A memory backend such
as Memhub is an optional adapter, not a second authority or mandatory runtime.

**Naming:** `Synrex` is the public-facing brand, with the descriptor
*Governed execution for AI*. Brand use does not imply trademark or domain
clearance. Historical `Rev` and `DevSpace Verge` identities remain in
release/provenance records; `devspace` remains an operational compatibility
namespace for existing clients. An authorized branding update may change
public-facing copy, package metadata, and introduce `synrex` CLI aliases.
Migrating OAuth issuers, active MCP URLs, state, existing secrets, and runtime
identities is a **separate**, tested, reversible operation.

## Product principles

1. **Model-led.** The external conversational host owns primary reasoning,
   planning, and decisions. Synrex exposes inspectable tools, durable work state,
   and verification evidence; it must not silently replace GPT with a second
   paid/API/CLI agent or claim to wake a model after its turn ends.
2. **Outcome-first.** Optimize verified end-to-end task success, correct
   artifacts, recovery, and low human intervention. Tool count and feature
   count are not outcome measures. Report failures and indeterminate states.
3. **Efficient by design.** Make project instructions, tool schemas, output,
   polling, retrieval, and transport economical by default, without losing
   actionable diagnostics or essential project constraints. Full evidence must
   remain retrievable by stable reference when previews are compact.
4. **Reliable continuity.** Give substantial work explicit identities,
   resumable checkpoints, durable processes, logs, receipts, and recovery
   rules. Never blindly replay an operation that may have had side effects.
5. **Governed autonomy.** Allow ordinary work within approved scope without
   repetitive approval prompts. Protect project identity, architecture
   boundaries, privileged mutations, credentials, deployment, and physical
   equipment with proportionate, enforceable controls and explicit authority.
6. **Minimal and composable.** Favor a small execution core and existing
   libraries/adapters over duplicated frameworks, storage, agent loops, and
   domain-specific orchestration. Add complexity only for demonstrated gain.
7. **Owner-controlled and portable.** Keep the user's data, credentials,
   filesystem, and execution authority under their control. Optimize for GPT
   where useful, while keeping the execution domain and protocol contracts
   usable by other compliant AI hosts.

**Decision precedence:** safety and explicit authority > correctness and
protected architecture > verified task completion > context/latency efficiency
> feature breadth. This is a tie-breaker, not permission to ignore user intent.

## Governance tiers (policy intent, not a claim of sandbox enforcement)

| Tier | Example | Expected behavior |
| --- | --- | --- |
| L0 inspect | Read files, search, check state or diagnostics | Autonomously within approved scope |
| L1 ordinary work | Edit normal code, create worktree, build, test | Autonomously in the selected workspace; verify outcome |
| L2 protected change | Rewrite architecture contracts, privileged configuration, critical APIs, release authority, cross-node permissions | Require applicable explicit authority, impact review, and tests; record decision |
| L3 high risk | Irreversible deletion, sensitive credential access, dangerous hardware/robot motion, unauthorized scope crossing | Refuse or stop absent independently enforceable authorization and safety conditions |

Tier checks should be enforced where the real operation occurs. Current shell
tools run with the local user's authority and are **not** a sandbox. An
`AGENTS.md` instruction or model self-check alone cannot guarantee L2/L3
enforcement. Unknown outcomes and unmet safety prerequisites fail closed.

## Explicit non-goals

- Build or silently substitute a competing general-purpose reasoning agent.
- Guarantee ChatGPT model continuation after the host conversation stops;
  only independent execution processes can continue unattended.
- Turn the core into Research Harness, a robotics controller, a paper-writing
  framework, or an all-purpose autonomous research agent.
- Reimplement Memhub, Normify, a general cluster orchestrator, or a second
  source of truth when a bounded adapter or existing component suffices.
- Build a multi-tenant public SaaS, a general-purpose Kubernetes replacement,
  or a default browser-accessible shell as a side effect of expanding coding.
- Allow learned memories, generated instructions, or the agent itself to
  silently override protected architecture, permissions, or user decisions.
- Claim speed or capability superiority without comparable, valid task runs.

## Architecture decision rules

For meaningful changes, apply these tests in order. Ordinary bug fixes should
not incur full design-review overhead.

1. **Product value:** State which real coding/execution outcome improves and
   how it will be verified. If no concrete user/task value exists, do not add
   it to the core.
2. **Correct layer:** Put generic tools in Synrex; subject-matter protocols in
   the calling project (e.g., Research Harness). Keep model/host/provider and
   transport specifics in adapters, not the core domain model.
3. **Authority and facts:** Code/actual runtime/tests establish behavior;
   versioned approved architecture establishes intended boundaries; run logs
   establish task outcome; cited memory provides useful historical evidence.
   No summary overrides a stronger source.
4. **Execution locality:** Workspace, Git, ROS2, processes, and durable tasks
   belong to the execution peer. The coordinator handles ingress, discovery,
   routing, and necessary indices; it never invents process ownership.
5. **Failure semantics:** Stable handles, causal receipts, observability,
   idempotent recovery when provable, and explicit indeterminate outcomes for
   uncertain non-idempotent writes. Never equate a completed MCP call with a
   completed engineering objective.
6. **Bounded contexts:** Load instructions/skills/knowledge when relevant;
   deduplicate unchanged content; return compact results with retrievable
   evidence. Never discard required warnings or failure evidence to save bytes.
7. **Protected changes:** Classify risk before altering architecture, secrets,
   deployment, permissions, or hardware interfaces. User-approved architecture
   evolution is allowed, but contracts, tests, and decisions must stay aligned.
8. **Releases and compatibility:** Development sources and pinned production
   releases are separate. Require reproducible build identity, relevant tests,
   compatibility checks, backup, and rollback for an authorized promotion.
   Never change the live OAuth/MCP identity merely to change a brand.
9. **Evidence-based reuse:** Prefer an existing dependency/interface to a new
   subsystem. Record added operational cost and accept only if task outcomes
   justify the new responsibility.

Use a short Architecture Decision Record (ADR) for cross-cutting protected
changes: problem, options, decision, authority, affected contracts, evidence,
reversibility. No new ADR is needed for each ordinary code edit.

## Success measures and next acceptance gates

Primary: verified end-to-end task success and human interventions. Supporting:
wall time, context bytes/tokens, tool calls/polls, p50/p95 latency, task
recovery correctness, unsafe replay incidents, governance violations and false
positive blocks. Compare GPT + baseline DevSpace, GPT + Synrex, and native coding
agent benchmarks where task/model/environment comparability is explicit.

Current priority is **proving the existing coding loop**, not adding features:

1. Reconcile dirty source and pinned deployed release provenance.
2. Verify real GPT host tool-schema compatibility and substantial
   inspect-edit-test-fix-review flows.
3. Test new-chat continuation, link loss, durable-task lifecycle,
   and non-idempotent retry safety under fault injection.
4. Measure context/polling overhead and architecture governance benefits.
5. Improve knowledge/memory only when real task comparisons show value.

Follow `docs/SYNREX_PRODUCT_ROADMAP.md` for specific implementation milestones
and the latest deployment evidence. This charter governs direction and scope;
it must not be mistaken for a delivery completion report.
