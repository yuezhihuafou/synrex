# GPT-led Subagent delegation and observed efficiency (2026-10-27)

Status: source implementation pending pinned release. Synrex remains the
execution layer for ordinary ChatGPT; external agents do not become a hidden
planner or a prerequisite for normal coding.

## Delegation policy

- GPT owns requirements, architecture, task decomposition and independent final
  acceptance. Prefer one bounded Subagent for a substantial independently
  verifiable multi-file investigation/implementation, review or test synthesis.
  Simple one-file reads, patches and quick checks stay with native Synrex.
- Reuse agent sessions and explicit versioned Context Pack references for one
  ongoing task. Parallelize independent read-only scopes; avoid concurrent
  writes to the same checkout. Isolate writers in registered Git worktrees
  and preserve the existing single-owner release transaction.
- Do not launch an agent merely because its provider quota is unused. On
  structured provider failure, retain the receipt and use bounded native tools
  as needed. Agent success is not user-goal success.
- The managed Subagent Skill describes concrete CLI usage. Compact MCP
  initialization instructions make the task threshold visible even with the
  existing on-demand skill setting; operators may use preload selectively.
  No second scheduler, model auto-loop, new credential authority or daemon.

## Console metrics

- Reuse 30-day bounded MCP diagnostic events and the existing owner SQLite
  local_agent_sessions and optional local_agent_events tables. A
  24-hour **local-workspace** comparison shows server-observed tool starts,
  new Agent sessions, terminal Agent turns, duration and Agent-turn success.
- Show individual Agent task IDs with Provider/status, not private prompts,
  shell commands, provider session tokens or raw filesystem paths.
- Tool calls are only joinable to agents at **workspace scope**. Without an
  explicitly verified common task identity, a GPT tool call cannot be
  attributed to a specific user task or Agent session. User-task success
  therefore remains null; Agent-turn completion is labeled separately.
- Missing optional Agent telemetry does not stop the independent Console
  snapshot collector. Truncation is explicitly disclosed. Cross-peer events
  are not invented or treated as local execution.
- The release acceptance includes a real Console snapshot from the pinned
  package, current source/release identity, and no regression in its 15-second
  worker or in the previously independent OAuth/ingress/rollback path.

## Evaluation still required

Compare representative engineering tasks before/after adoption using verified
completion, host MCP calls, Agent turns, repeated inspections, time, retries,
and failed Provider runs. Do **not** infer a speedup or ChatGPT reply-stream
fix from code coverage or a single Agent probe. Provider outages and model
tokens unavailable from the host must be labeled unknown or excluded.
