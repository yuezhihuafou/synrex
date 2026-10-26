# Development learning in Synrex

This is project-scoped, owner-controlled memory inside the existing
`LearningStore`, not a second AI agent or mandatory MemHub server.

## Daily usage

1. **Start:** call `project` with `action: "learn_recall"` and a focused
   `args.query` before revisiting a familiar bug.
2. **During a substantial workflow:** use `workflow_checkpoint`. Its latest
   summary, completed steps, checks and remaining work automatically upsert
   one lightweight retrospective. Checks are **self-reported** here.
3. **After debugging:** call `project` with `action: "learn_review"`; it
   returns recent notes, failures and recurring verified test commands. The
   host GPT, not a hidden model, determines the actual cause.
4. **Save the learning:** call `project` with `action: "learn_record"`.
   Provide `title`, `summary` and
   `args: { taskKey, outcome, rootCause, resolution, lessons, checks,
   nextSteps, evidenceEpisodeIds }`. Reusing a taskKey updates the same
   note. Include failed evidence for incident history and successful checks
   when applicable. Record uncertainty rather than inventing a root cause.
5. **Promote a reusable procedure:** call `project learn_distill` with
   `args: { noteId, evidenceEpisodeIds }`; override title/trigger/procedure
   when needed. Review the candidate and run the actual tests. Call
   `project learn_promote` with `args: { candidateId, validationNote }`
   only after the named verification command passed. Promotion writes
   `.agents/skills/<slug>/SKILL.md` without replacing a different Skill.

All project actions need `workspaceId`. `project help` lists exact options.
On older six-tool ChatGPT clients the read-only compatibility commands
`devspace-project learn-review`, `learn-recall QUERY`, `learn-suggest`
and `learn-stats` remain accessible through `exec_command`. Writes require
the full `project` tool.

## Trust and operational limits

- Notes are summaries, not proof of success; original receipts are the
  evidence source. Pending task handles are not successful verification.
- Workflow notes are created without extra model calls or background jobs.
  Meaningful root-cause analysis still requires the conversational host to
  invoke `learn_record`; it is not automatic LLM reflection.
- Records are keyed by workspace root; worktrees have distinct learning
  histories. Do not silently treat different worktrees as one project.
- Promotion requires recent successful test/check evidence in the same
  workspace and an explicit matching command in the procedure.
- Promotion never rewrites an existing nonidentical project Skill or
  overwrites protected architecture. Reopen the workspace to discover a
  newly promoted Skill.
- SQL state upgrades occur on the candidate's state database when first
  opened. No live swy1 service is modified by changing a development worktree.
