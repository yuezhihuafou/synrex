---
name: repository-publish
description: Manage Git version history, GitHub commits, pushes, and production release provenance for a multi-host project. Use when asked to commit, push, publish, release, tag, sync branches, compare development versus deployed versions, or fix a Git remote. Prefer the project's canonical main branch; never invent a remote feature/release branch or confuse a production artifact with development HEAD.
---

# Repository publishing

Use existing `git`, `gh`, and repository-specific release scripts. This skill adds **project policy**, not a Git reimplementation. Read `policy.json`; consult `references/WORKFLOW.md` for source-vs-production or multi-host comparisons.

## Routine commit / push

For Synrex concurrent-chat work, run `python3 scripts/synrex-p0.py worktrees
--base origin/main` and use `integration-plan --candidate <commit>` for each
selected source before staging. The plan is read-only and identifies possible
changed-file overlap; preserve dirty peers and unknown refs. Read
`docs/platform/SYNREX_P0_CONTINUITY_INTEGRATION.md` before modifying the
public ingress or doing a production service cutover. Gateway is not the
mandatory development host.

1. Determine the actual project, host, checkout/worktree, dirty status, `HEAD`, configured origin, remote default branch, and production release (when relevant). Run `python3 scripts/publish.py inspect` from the intended repository, using the skill script's full path. Do not guess newest by time, branch name, or host. Never stage all dirty files from another task.
2. Scope and review edits, check for secrets, run relevant tests; stage exact files/hunks and make one coherent commit. Preserve unrelated work.
3. **Default destination is canonical `origin/main`.** If working on another branch/detached worktree, integrate *selected* tested commits into a clean local `main` checkout based on fetched `origin/main` using fast-forward/cherry-pick as appropriate. Do not push the source branch merely because it is checked out. Resolve conflicts explicitly; do not force a merge of unrelated histories.
4. Run `python3 scripts/publish.py push-main` **from checked-out `main`**. It checks canonical remote, the remote's default branch, clean tree, and fast-forward ancestry, then uses an explicit `HEAD:refs/heads/main` refspec without force and verifies the remote SHA. Failure is a blocker, not permission to make a new branch.
5. Report repo, host, source commit, pushed destination, final remote SHA, tests and anything excluded. A push is not a deployment.

## Explicit exceptions

- **User specifically requests PR/review:** a named feature branch is allowed; use `gh pr create --base main --head ...` after checking intent. Never invent remote feature/release branches for an ordinary "push latest" request.
- **Production release:** inspect actual running service and immutable manifest via `python3 scripts/publish.py inspect-production`. Compare its `sourceRevision` with Git. Tag *only* a verified release commit with an intentional immutable version tag and publish via the project's release procedure. Do not retag, force-push, or infer production is current `main`.
- **Different hosts diverge:** enumerate commit ancestry, unique changes, and dirty states. Choose what to integrate based on evidence and user intent; do not overwrite the more complete host or bundle dirty unreviewed work.
- **Main protected or behind:** stop on a non-fast-forward or protection denial; use an explicit reviewed PR when needed, not an arbitrary new branch or force option.
- **Wrong repository, unavailable authentication, unidentified production build, or unclear source:** do not substitute an unrelated GitHub repository/branch. State the blocker precisely.

## Project integration

`policy.json` defines the canonical remote and default branch. A different project must provide its own policy, rather than inheriting Synrex identity. The script is a push gate, not a replacement for code review, CI, or release promotion. Compatibility paths (`devspace.service`, old OAuth/state locations) are not reasons to rename production identities during a Git-only task.

Example invocation (from repository root):

```bash
python3 .agents/skills/repository-publish/scripts/publish.py inspect
python3 .agents/skills/repository-publish/scripts/publish.py push-main
python3 .agents/skills/repository-publish/scripts/publish.py inspect-production
```
