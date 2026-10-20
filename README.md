[![CI](https://github.com/yuezhihuafou/devspace-verge/actions/workflows/ci.yml/badge.svg)](https://github.com/yuezhihuafou/devspace-verge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Synrex — Governed execution for AI

**Synrex** is a self-hosted, GPT-first coding and execution harness. ChatGPT
remains the primary reasoning agent; Synrex supplies workspace-scoped code
tools, execution, verification, durable tasks, workflow recovery, multi-host
routing, and architecture safeguards. Coding is the primary use case; generic
tools can also run authorized simulations, builds and data-processing tasks.

Synrex is an independently maintained derivative of
[Waishnav/devspace](https://github.com/Waishnav/devspace), previously known as
DevSpace Verge and Rev. It preserves the upstream MIT license, source
attribution, and compatible `devspace` configuration/CLI paths.

It is not an official DevSpace release.

**Deployment model:** one Owner per self-hosted installation. Every person
running Synrex supplies their own machines, domain, OAuth credentials and
state; there is no shared vendor-hosted hub or required multi-user service.
Single-machine coding is the default; optional execution peers can be used for
local models and simulations. See
[`SINGLE_OWNER_SELF_HOSTED.md`](docs/platform/SINGLE_OWNER_SELF_HOSTED.md)
for production security, automatic reconnection and persistence boundaries.

## Why Synrex exists

The upstream project provides the core idea: expose selected local coding
workspaces through MCP. Synrex keeps that foundation and develops it further for
heavy agent workflows rather than treating every tool call as a short,
fully-inline request.

Current Synrex-specific work includes:

- bounded model-facing command results while preserving complete local logs
- stable `runId` references with on-demand `read`, `tail`, `grep`, byte-range,
  and metadata retrieval
- durable long-running tasks that can detach from an MCP request and be queried
  later without occupying the conversation
- compact error/status reporting with exit codes and persisted terminal state
- conversation-aware workspace reuse and isolated Git worktree support
- semantic code navigation backed by Serena/LSP with bounded backend reuse
- versioned architecture intent with deterministic conformance checks, explicit
  architecture-change rationale, and optional LSP diagnostics as secondary evidence
- bounded caches and log retention to control long-session resource growth
- user-level deployment helpers for persistent remote Synrex installations
- compatibility with the existing local-agent and MCP workflow inherited from
  upstream DevSpace

The design goal is to give GPT an efficient, inspectable engineering execution
loop: maximize verifiable task completion while reducing context overhead,
interruptions, and architecture drift. Keep the model context high-signal
without throwing away the raw evidence needed for debugging and verification.

**Product contract:** [Product Charter](docs/PRODUCT_CHARTER.md), [Roadmap](docs/SYNREX_PRODUCT_ROADMAP.md),
and [ChatGPT plugin description](docs/PLUGIN_DESCRIPTION.md). Research Harness
is a separate research application, not a Synrex mode or mandatory dependency.

Architecture governance is documented in `docs/architecture-governance.md`.
Its purpose is design consistency during repeated agent edits, not to turn the
repository into a speculative knowledge-graph project.

## Status

Synrex is usable, but it is still an early independent release line. The first
independent release started at `0.1.0`; this version number is intentionally separate
from upstream DevSpace's release numbering.

Linux is the primary production and release-gated environment. macOS is part of
the blocking pull-request smoke matrix. Windows remains a compatibility signal:
the inherited runtime is exercised there, but known Windows-specific command
shell and lifecycle differences mean the full Windows suite is not yet a release
gate.

## Requirements

- Node.js `>=22.19 <27`
- pnpm `11.25.0`
- Git
- a Bash-compatible shell for the existing cross-platform workflow

For the supported release path, use Linux. macOS is continuously smoke-tested.
Windows should currently be treated as best-effort compatibility rather than a
fully supported production target.

## Install from source

```bash
git clone https://github.com/yuezhihuafou/devspace-verge.git
cd devspace-verge
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
npm link
```

The preferred CLI is `synrex`; `devspace` remains a compatible legacy alias
using the same configuration and runtime (no duplicate state):

```bash
synrex init
synrex doctor
synrex serve
```

For a persistent Linux user service, see `docs/compact-runtime.md` and:

```bash
bash deploy/install-user-service.sh
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
pnpm typecheck
pnpm test
pnpm test:package-install
pnpm benchmark:compare results.jsonl
pnpm build
```

`dev:seed` creates checkout-local development state so source testing does not
modify the normal installation. See `docs/development.md` for the development
and manual-QA workflow.

## Project layout

- `src/` — MCP server, workspace/runtime logic, durable tasks, semantic tooling,
  local-agent integration, and tests
- `bin/` — command-line launchers
- `docs/` — operation, development, security, and Synrex runtime documentation
- `deploy/` — persistent user-service deployment helpers
- `schema/` — configuration schema
- `skills/` — agent-facing skills shipped with the project
- `test/` — package/install smoke tests

## Relationship to upstream

Synrex (formerly DevSpace Verge / Rev) is derived from
[Waishnav/devspace](https://github.com/Waishnav/devspace), by Waishnav and
contributors. The original copyright and MIT permission notice are preserved
verbatim in `LICENSE` as required by that license. `NOTICE` records the
relationship between the upstream work and this independently maintained
derivative.

Where Synrex has not intentionally changed behavior, upstream DevSpace
documentation remains useful as background. Synrex-specific behavior and release
instructions in this repository take precedence for this fork.

## License

MIT. See `LICENSE` and `NOTICE`.

The MIT license permits modification, redistribution, publication, sublicensing,
and sale of copies, provided the original copyright and permission notice are
included in copies or substantial portions of the software.
