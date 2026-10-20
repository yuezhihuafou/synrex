# Architecture governance

Synrex architecture governance exists to keep long-running agent work aligned with an explicit project design. It is not a replacement for tests, type checking, or code review, and it is not a security sandbox: shell commands still run with the local user's authority.

## Two separate models

The intended architecture is stored in the repository as `.devspace-architecture.json`. It is normal version-controlled project input: branches, pull requests, and Git history show design changes explicitly.

Observed structure is regenerated from the working tree under `.devspace/architecture/`. It contains discovered source modules, content fingerprints, and dependency facts. This directory is runtime state and remains ignored by Git.

Normal source additions, removals, and moves therefore change observed structure without silently changing intended architecture.

## Change discipline

Ordinary implementation changes may alter source code but may not alter intended architecture. Architecture annotations or policies require an explicit architecture change and a rationale. Closing that change validates the resulting code and records the accepted intent fingerprint.

Direct model-facing write/edit/patch operations reject the tracked architecture file and generated architecture state. `show_changes` also runs conformance, so shell-based or external edits to the architecture file cannot quietly pass review. On a fresh local runtime, the initial intent fingerprint is anchored to the version committed at Git `HEAD` when one exists.

When a branch switch or pull brings in a different architecture file that is already committed at the current Git `HEAD`, Synrex accepts that committed version as the new local baseline instead of reporting false drift. Uncommitted divergence from `HEAD` still requires the explicit architecture-change path.

## Executable rules

Policies support `forbid_dependency` and `require_dependency` rules with source and target path globs. Module annotations can carry the same executable dependency contracts, or a `note` contract for rationale that is intentionally non-executable.

The current deterministic dependency provider resolves local TypeScript/JavaScript import, export, require, and dynamic-import edges, conservative local Python imports, and quoted local C/C++ includes. Ambiguous Python/C/C++ resolutions are omitted rather than guessed, so missing evidence cannot create a false blocking edge. Serena/LSP diagnostics can be requested as secondary evidence for changed files touched by executable architecture rules. They are deliberately not part of the default `show_changes` gate: a cold or unavailable language server must not slow down or create false architecture warnings during normal review. Additional language-specific dependency providers can be added without changing the intended-architecture format.

Run the same conformance check locally with:

```bash
pnpm architecture:check
```

Add `-- --semantic` to include Serena/LSP diagnostics for currently changed,
governed files. Deterministic architecture errors remain the blocking signal;
semantic diagnostics are reported as warnings.

The project should prefer a small number of durable rules that protect real boundaries over a large speculative rule set. Rules that create recurring false-positive blocks should be removed or made more precise.
