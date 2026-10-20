# Synrex

**Read `docs/PRODUCT_CHARTER.md` before planning substantive product changes.**
It is the normative product mission, principles, non-goals, risk tiers, and
architecture decision filter. `docs/SYNREX_PRODUCT_ROADMAP.md` tracks actual
milestones and acceptance evidence. For cross-cutting work, check both against
the actual runtime/source/tests; ordinary fixes need no extra ceremony.
`Synrex` is the public-facing product name. Historical `devspace` paths,
configuration keys, OAuth endpoints, storage files, and service names are
compatibility interfaces, not a competing brand. Do not change live identities
without a separately tested, reversible migration.

Product name: **Synrex**. Synrex is the standalone GPT-led coding and remote
execution platform. **Research Harness is a different project** which may
use Synrex through its generic tools; it is not a Synrex feature, mode, milestone or
mandatory dependency. The consolidated Synrex roadmap is
`docs/SYNREX_PRODUCT_ROADMAP.md`. Ordinary ChatGPT is the primary reasoning host;
the independently authenticated Synrex Web Console is for operational visibility,
not a replacement coding agent.

## Equal execution peer architecture (2026-10-14)

All Synrex hosts (swy1, gateway, Windows) are complete execution peers.
An optional coordinator owns only shared OAuth ingress, node discovery, project
and task location indices, and authorization/routing; it must not supervise
or centralize a peer's local Git, ROS2, shell, simulation or durable tasks.
swy1 is the primary owner/coding host (including ROS2). gateway is optional
compute for local models and simulation; the system must operate while it is
offline. The legacy `gateway`/`worker` role strings are
supported aliases of `coordinator`/`peer`. Never switch public ingress
or duplicate writable OAuth/directory authority without a validated,
reversible cutover. Different peer builds are allowed when actual requested
tool contracts and security protocols match; no forced source equality.
External memory integrations are optional, never prerequisites for ordinary
coding or physical robot command authority.

## Live service ownership since 2026-10-19

The production public Synrex MCP/OAuth coordinator is on swy1. Its
`devspace.service` uses an immutable, pinned release under
`/home/swy/services/devspace/releases/`. **Determine the currently active
release from `systemctl --user show devspace.service -p ExecStart`** rather
than trusting a release path printed in older documentation. As of 2026-10-20
the release is `20261020-rev-console-ui0-v1`, with
`DEVSPACE_CONFIG_DIR=/home/swy/.devspace-cutover-20261018`.
The authoritative directory database is
`/home/swy/.local/share/devspace-cutover-20261018/devspace.sqlite`.
Do not replace this production release with the mutable swy1 ROS2 checkout
or overwrite the state using an obsolete 2026-10-13 gateway copy.
gateway is a normal peer using a persistent SSH relay; its Cloudflare Tunnel
must remain disabled while swy1 is public. The disabled old
`devspace-core.service` and swy1-to-gateway tunnel are not the live ingress.
Use the cutover audit and backups before any future authority transfer.
The owner-only self-hosting contract is at
`docs/platform/SINGLE_OWNER_SELF_HOSTED.md`. Existing OAuth client IDs can
reauthorize with the Owner password even while new-client enrollment is locked.
Daily verified owner-state backups and 15-minute read-only health checks run
from user systemd timers; never place a second public OAuth instance on gateway.
The currently pinned release must not be replaced by the mutable checkout's
`pnpm deploy:live` without an explicit, tested and rollback-safe promotion.

## Complete authorized work

Concise reporting does not reduce reasoning, verification, or task scope. An
intermediate finding, successful tool call, started task, or completed substep
is not completion of the user's goal. Continue authorized dependent work in
the same turn; use progress messages for updates, not a final answer asking
the user to say continue. End only when the requested outcome is verified,
the user stops the task, or a concrete blocker needs unavailable input or
authority. Report that blocker precisely and preserve actual task handles.

When a command returns a running task, honor its poll interval and retrieve
its terminal state and saved output before making dependent decisions. If
task_get is absent from the host tool snapshot, use exec_command with
`devspace-task get <taskId>`; do not treat a missing dedicated tool as a
reason to abandon a running task. Do not claim a host-wide reasoning setting
or account restriction was fixed by changing repository instructions.

Synrex is a local development execution layer for MCP hosts such as ChatGPT and Claude. It gives a remote host workspace-scoped tools for reading, editing, searching, running commands, managing Git worktrees, reviewing changes, and coordinating bounded subagents on the user's machine.

Pi's SDK currently provides mature local coding primitives. Synrex wraps those primitives in a Streamable HTTP MCP server and adds the product-specific boundaries around them: approved roots, workspace state, instructions, process sessions, worktrees, artifacts, review checkpoints, widgets, and subagent execution.

Synrex owns tooling mechanics. The model receives only meaningful and actionable choices. The user sees outcomes. Tool defination should not leak internal implementation or it shoudn't be giving unwanted options to model to choose from if tooling can handle this.

## Product model

These ideas should stay true as the project evolves:

1. **The host is the orchestrator.** Synrex exposes clear capabilities and execution state. It should not hide the workflow inside an opaque, uninspectable agent loop.
2. **Everything happens in a workspace.** A workspace represents one local project directory or worktree plus the instructions and state accumulated while operating in it.
3. **Local authority stays explicit.** Synrex runs with access to the user's machine. Roots, paths, commands, processes, credentials, and destructive operations must be treated as product boundaries.
4. **Subagents are bounded workers.** A subagent should have an explicit task, profile, working context, lifecycle, and result that the host can inspect and coordinate.
5. **Adapters stay at the edges.** Pi, MCP hosts, and model providers each have their own terminology and capabilities. Provider-specific behavior should not become the core domain model.
6. **Prefer composable primitives.** Build a small set of reliable operations that can be combined into larger workflows instead of baking every workflow into the server.

## Glossary

- **Host** — the MCP client presenting the agent experience and coordinating work.
- **Server** — the local Synrex MCP server.
- **Workspace** — one opened directory or worktree and its accumulated instruction context.
- **`workspaceId`** — the opaque handle returned by `open_workspace` and reused for calls in that workspace.
- **Allowed root** — a configured filesystem boundary within which a workspace may be opened. It is not itself necessarily a workspace.
- **Checkout mode** — operating on an existing checkout supplied by the user.
- **Worktree mode** — operating in an isolated Git worktree.
- **Tool surface** — the tools exposed by a configured mode, such as minimal, full, or Codex-compatible.
- **Process session** — a long-running command tracked for later input, output, or termination.
- **Instruction file** — an `AGENTS.md` or `CLAUDE.md` discovered while navigating a workspace.
- **Subagent** — a bounded model invocation delegated and coordinated by the host.
- **Agent profile** — the model, provider, tools, and instructions used for a subagent.
- **Artifact** — an output surfaced for the host or user to inspect.
- **Review checkpoint** — stored state representing a coherent set of changes.
- **Widget** — host-rendered UI/Cards attached to an MCP response.

Use these terms precisely. In particular, do not use workspace, allowed root, checkout, and worktree interchangeably.

## Security boundaries

Filesystem tools enforce approved-root containment. Shell commands run with the local user's authority and are not a general sandbox. Never imply that shell execution is contained merely because file tools are contained.

Resolve and validate paths before destructive actions. Do not broaden an allowed root, delete application state, expose a credential, or replace an existing process as a convenient fix.

Keep tunnel ownership and credentials with the user. Synrex may operate through a user-controlled tunnel, but it does not own tunnel lifecycle or configuration.

## Diagnose the correct layer

A failure may belong to the host, MCP transport, Synrex, a Pi adapter, a provider, a model, a tool implementation, or the target project. Preserve the original error and identify the failing boundary before changing code.

An adapter exception is not evidence that a model failed. A successful command is not evidence that a GUI opened, a host refreshed, or a user-visible workflow succeeded.

Do not expand Synrex's responsibility while fixing a local symptom. Host UI, provider model naming, tunnel management, and duplicated review experiences require an explicit product decision.

## Verify the real path

Determine how the user will consume the change and verify that path. Behavior may differ between:

- the source checkout and the packaged `npm`/`npx` installation;
- a direct terminal client and a real MCP host;
- a fresh process and a server or host that needs restarting;
- checkout mode and worktree mode;
- Linux, macOS, and Windows Bash environments;
- minimal, full, and Codex-compatible tool surfaces;
- widgets enabled, disabled, or limited to change review.

State clearly when only a narrower proxy was verified. For model-facing schemas, inspect what the host receives. For UI and artifacts, inspect the rendered result rather than inferring success from the producing command.

## Live deployment invariant

This checkout is a **mutable development source**, not the executing
production release. Source changes are not deployed merely because they
are saved, tested, committed or compiled. Never label an undeployed source
change a production feature.

After a successful authorized feature change:

1. Inspect the full diff, preserve all unrelated dirty checkout state, run
   relevant tests/typecheck, and build a **new versioned immutable release**
   based on the last known good release. Record source/tool-schema and
   asset checksums; never overwrite previous release assets.
2. Exercise the pinned candidate with disposable OAuth/SQLite and a **real
   HTTP MCP or browser test**. Explicitly verify any changed frontend route,
   authorization boundary and existing MCP behavior.
3. Back up production OAuth, SQLite, workflows and release settings with
   `deploy/backup-owner-state.py`. Promote via the tested
   `deploy/activate-owner-release.sh` with automatic health-check rollback.
   **Never run `pnpm deploy:live` from this dirty mutable checkout to
   replace the production owner release.**
4. Confirm actual `devspace.service` ExecStart, localhost health,
   SQLite integrity, external OAuth metadata, and changed browser/MCP path.
   A running ChatGPT conversation may still expose an older tool snapshot.

An isolated QA build alone is not a completed deployment. Keep production
untouched when release verification or rollback prerequisites are missing.

## Trace affected contracts

When changing a cross-cutting concept, check every surface it actually reaches:

- MCP schema, handler, description, and response;
- workspace lifecycle and instruction loading;
- allowed-root and path-containment behavior;
- checkout and worktree modes;
- process and subagent lifecycle;
- tool-surface filtering;
- widgets, artifacts, and review checkpoints;
- persistence and migrations;
- packaged entry points, documentation, and examples.

This is a map, not a requirement to touch every surface on every change. Avoid both incomplete contracts and speculative edits.

## Pull requests

Only create or update a PR when explicitly asked, and read `CONTRIBUTING.md` first. Keep a PR focused on one coherent concern and use a conventional title such as `fix:`, `feat:`, `docs:`, `refactor:`, or `chore:`.

Write the body as a few natural paragraphs explaining the problem and solution. Include verification, risk, or migration context only when it helps the reviewer. Avoid generated boilerplate, commit inventories, file-by-file narration, generic checklists, and mandatory `Testing` sections.

For UI changes, include before/after images and a short interaction video when behavior changes. Inspect the final diff before filing. When available, use the `file-pr` workflow to file the PR and `babysit-pr` to monitor CI and reviews.

## Where code lives

- `src/server.ts` — MCP server setup, tool registration, and response wiring.
- `src/workspaces.ts` — workspace lifecycle, instructions, skills, and profiles.
- `src/roots.ts` — allowed roots and path containment.
- `src/process-sessions.ts` — long-running process lifecycle.
- `src/git.ts` and `src/git-worktrees.ts` — Git and worktree operations.
- `src/local-agent-*.ts` — subagent configuration, providers, and execution.
- `src/artifact-*.ts` and `src/incoming-artifacts.ts` — artifact handling.
- `src/review-checkpoints.ts` — persisted change-review checkpoints.
- `src/ui/` — MCP widgets.
- `src/db/` — persisted local state and migrations.
- `test/` — behavior and regression tests.

Start at the boundary named by the problem and follow the data. Keep policy in Synrex, provider translation in adapters, and important behavior in schemas, types, checks, or explicit tool results rather than hidden prompt conventions.

## Project taste

- Prefer explicit lifecycle and state over hidden autonomy.
- Make tasks, inputs, outputs, failures, and ownership inspectable.
- Keep subagent execution composable and independently testable.
- Preserve host and provider data unless Synrex has a concrete reason to normalize it.
- Add compatibility behavior only for an identified consumer with a real upgrade path.
- Reuse glossary terms in schemas, types, documentation, and errors.
- Keep the execution layer small, reliable, and unsurprising.
