---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded Synrex subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# Synrex subagents

Subagents are optional. Use the normal workspace tools for routine work; delegate only when a separate worker materially helps through independent context, specialization, or follow-up.

## GPT-led delegation protocol

GPT retains requirement analysis, task boundaries, architecture decisions and **independent final acceptance**. Prefer a single bounded Subagent over a sequence of fine-grained GPT tool calls when an outcome is substantial and independently verifiable: repository-wide discovery, multi-module analysis/implementation, review, or synthesis of many test results. The goal is fewer GPT tool turns and verified task success, **not** higher model quota consumption or more Subagents.

- Keep simple reads, small patches, health checks and fast source inspection in native Synrex tools. Batch up to eight independent file ranges with `read.files`; group safe read-only shell queries.
- Before starting an agent, define a deliverable, exact workspace, allowed files/commands, constraints and expected verification. Read the current Git state and use an **isolated worktree** for any independent writer. Never hand two writers the same checkout. Production release remains the single guarded transaction owned by GPT.
- For continuing work, use `agents continue <id>` and a previously built `--context-ref` when still current. Use `--workflow`, `--context-file` or `agents context build` when a task needs versioned source hints or workflow state; don't rebuild Context Packs after every model turn.
- Parallel Subagents are appropriate for independent **read-only** scopes; serialize integration and final testing. Prefer at most a few meaningful work packages, not one Subagent per file, search or command.
- Treat a completed agent turn as **agent execution evidence**, not user-objective success. Inspect its diff, citations and tests before integration. If the agent/daemon is unavailable, fall back to bounded native tools without spinning or blind retries.
- **Return to the original parent request after every terminal agent result.** A partial response, an unverified claim, an empty result, or a provider failure never satisfies the parent task. Review the original acceptance criteria, inspect worktree/agent evidence, take the next authorized corrective action in the same GPT turn, and run independent final checks. Do not start a new agent merely to restate the previous result; prefer one bounded follow-up with the existing agent or native tools. If blocked by genuinely missing authority, report the exact unmet criterion and retained agent ID.
- Synrex cannot make an ordinary ChatGPT turn resume itself. Prefer one durable task receipt and backoff-guided `task_wait` over repeated polling; only inspect again when output or an independent dependency demands it.

Use the Synrex CLI through the shell or process tool. Run commands from the project the subagent should work on.

## Choose a target

Discover usable targets instead of guessing names:

```bash
synrex agents targets --json
```

Configured profiles include a description and may define provider, model, effort, and task instructions. Choose a matching profile when one fits. Use a provider target when no profile fits or a specific provider is needed.

Usually rely on the target's configured model and effort. Pass `--model` or `--effort` only with a value supported by that provider. Synrex passes these values through without translating them between providers.

## Start work

Give the subagent a self-contained brief. Include the objective, relevant paths, constraints, decisions it needs from the current conversation, and the expected result. The subagent receives the brief and its profile instructions, not the parent conversation.

```bash
synrex agents run <profile-or-provider> "<brief>" --json
synrex agents run <profile-or-provider> --model <model> --effort <effort> "<brief>" --json
```

The result contains a Synrex agent `id` and its current status. Execution continues independently, so retain the ID for later inspection or follow-up.

## Inspect and continue

```bash
synrex agents show <id> --json
synrex agents continue <id> "<follow-up brief>" --json
synrex agents ls --json
synrex agents events <id> --json
synrex agents watch <id> --json
synrex agents stats --json
```

- `show` waits briefly for active work, then returns the current status and any
  available response or error.
- `continue` gives the same subagent another turn with its existing provider
  session and context.
- `ls` returns sessions belonging to the current project.
- `events` returns a paginated, persistent execution timeline; use the last
  event's `seq` as the `after-seq` argument for incremental reads.
- `watch` tails streamed event metadata until completion or a bounded window.
- `stats` summarizes completed turns, measured duration, and provider-reported
  tokens for the current workspace; missing usage remains `null`.

Run `synrex agents show <id> --json` again later while the status is `running`.
`completed` includes the response. `failed` includes a structured error, and
`stopped` is terminal without a successful response. Continue an agent when its
existing context is useful; start another agent for unrelated work.

## Good uses

- Review a change for correctness, security, or missing tests.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
