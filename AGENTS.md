# Synrex — concise agent entrypoint

**Before substantive product changes, read `docs/PRODUCT_CHARTER.md` (normative intent) and consult `docs/SYNREX_PRODUCT_ROADMAP.md` (verified delivery status).** Source, the pinned release, and tests establish actual behavior. Ordinary fixes do not need extra process. Read `docs/SYNREX_AGENT_PLAYBOOK.md` for changes involving security, release, multi-node routing, data/architecture contracts, UI, PRs, or production operations; it preserves the full engineering rules and paths without loading them for every simple task.

## Product and authority

- **Synrex is a GPT-led coding and execution harness**, not a replacement autonomous reasoning agent. Ordinary ChatGPT is the primary reasoning host. Research Harness is **a separate project**, never an implicit Synrex feature or dependency. External memory integrations are optional.
- The model plans; Synrex executes and returns inspectable work, durable task IDs, checkpoints, logs, and evidence. Do not claim a command, test, UI, deployment, or user goal succeeded from a partial tool response. Continue authorized dependent work and verify the final outcome in the same turn.
- **Honor the requested delivery target.** If the user explicitly asks to merge a QA/experimental version into `swy1` production, integrate the feature into the current production baseline, validate it, and promote a pinned release. An isolated QA container, a staging server, a plan, or a copied binary is an *intermediate test only*, never a substitute for production delivery. If the production gates fail, report the specific blocker rather than silently downgrade the objective. Do not replace a newer production build with an older QA snapshot.
- Maintain explicit authorization, allowed paths, project architecture, and actual host state. Shell commands run with the local user's authority and **are not sandboxed**. Never relax roots, expose secrets, silently replay uncertain writes, delete state, deploy a mutable checkout, or trigger dangerous robot motion without independent safety authorization.

## Workspace and execution

- Open a workspace once per project/isolated worktree; reuse its `workspaceId`. Read applicable `AGENTS.md`/`CLAUDE.md` and matching advertised skill instructions before editing. Use `read` for direct file reads, `apply_patch` for all file edits, and `exec_command` for shell/tests/search. After final changes call `show_changes` **once** for review.
- Prefer a **small number of well-scoped tool calls**: combine independent searches or verification commands when safe; avoid repeated workspace opens, status polls, redundant context dumps, and unnecessary subagent invocations. Never skip validation to save latency.
- Long commands may detach with a durable `taskId`/`runId`. Prefer bounded `task_wait`, or `exec_command` with `devspace-task wait <taskId>` on older six-tool hosts; use `devspace-task get <taskId>` for immediate status. Retrieve terminal outcome and bounded logs. Do not treat completion of the MCP call as completion of the task; a tool cannot restart ordinary GPT reasoning after its turn ends.
- While a durable command is running, continue useful independent work: a completed local job can appear as a bounded Completion Mailbox notice on a later same-workspace response. On six-tool clients, a notice may appear in `structuredContent.result` after the explicit `Synrex task status (not source content)` separator; `structuredContent.sourceResult` retains the exact original output. Never treat status text as source code. Verify the task receipt before using it. When independent work is exhausted, `task_wait(final=true)` or `devspace-task final <taskId>` gives bounded diagnostics; unresolved tasks must not be declared successful.
- Workflows are for substantial work needing cross-turn continuity. Check the actual Git state, tests, receipts and blockers on resume, and checkpoint genuine progress; do not create workflow ceremony for ordinary one-step fixes.

## Nodes and live release

- All hosts are execution peers. `swy1` owns the public single-owner MCP/OAuth coordinator and primary coding environment; `gateway` is optional compute and Windows is optional. Never force identical source revisions; negotiate actual contract compatibility. Never duplicate OAuth authority or send physical robot operations to an unintended node.
- The swy1 public service is an **immutable pinned release** under `/home/swy/services/devspace/releases/`; this checkout is mutable development source. Determine the active release from `systemctl --user show devspace.service -p ExecStart`, never an old document path. Preserve OAuth issuer, client identity, SQLite, backups, old CLI names and rollback ability. Never run `pnpm deploy:live` from this checkout.
- Deployment requires clean reproducible source, packaged immutable candidate, tests/typecheck, isolated authenticated HTTP MCP/browser QA, owner-state backup, rollback-safe activation and verification of the real live client path. When any prerequisite is missing, leave production untouched and report the exact gate.

## Diagnosing changes

- Failures may arise in GPT/host, MCP transport, Synrex, adapters, providers, peers or the target project. Identify the failing layer using real traces before changing code. Measure end-to-end completion, context/tool calls, request RTT and recovery, not only microbenchmarks or feature count.
- Keep tool contracts, root checks, worktree/checkout, durable process ownership, routing, authorization and saved artifacts consistent. Reuse existing libraries and adapters; do not add another orchestrator, storage authority or hidden agent loop. Protect architecture decisions and risk-tier approval rules in the Charter.
- For nontrivial changes follow the full playbook and affected contracts, then inspect diff, run relevant tests and verify the user's consumption path. For a PR request, read `CONTRIBUTING.md` and the playbook before creating it.
