[![CI](https://github.com/yuezhihuafou/synrex/actions/workflows/ci.yml/badge.svg)](https://github.com/yuezhihuafou/synrex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/yuezhihuafou/synrex?include_prereleases)](https://github.com/yuezhihuafou/synrex/releases)

# Synrex — Governed execution for AI

**Use ChatGPT as your engineering interface. Keep execution on your own machines.**

Synrex connects conversational AI to real repositories and long-running engineering work over MCP, with durable jobs, inspectable evidence, and optional execution peers.

**[Get started](#install-from-source)** · **[Architecture and scope](docs/PRODUCT_CHARTER.md)** · **[Deployment](docs/platform/SINGLE_OWNER_SELF_HOSTED.md)** · **[Releases](https://github.com/yuezhihuafou/synrex/releases)** · **[Contributing](CONTRIBUTING.md)**

> **Early release:** self-hosted, single-owner deployment. Linux is the primary supported platform. Synrex is not a hosted service; end-to-end performance superiority over upstream DevSpace has not yet been established.

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

Synrex is usable, but it is still an early independent release line. The
`v0.2.0` milestone was a self-hosted public preview; `v0.3.0`
consolidated the independently deployed Console and portable deployment.
The `v0.4.0` source line closes verified historical feature gaps with
workspace lifecycle, safe retention and release-aware observability. Check the actual
GitHub release and live manifest before assuming a source change is shipped.
Versioning is separate from upstream DevSpace's release numbering.

For a reproducible demonstration, use the deliberately failing test fixture in
[`examples/public-demo`](examples/public-demo) and follow the
[recording checklist](docs/launch/PUBLIC_DEMO.md). This shows an actual
inspect → edit → test → verify loop rather than a prepared success screen.

Linux is the primary production and release-gated environment. macOS is part of
the blocking pull-request smoke matrix. Windows remains a compatibility signal:
the inherited runtime is exercised there, but known Windows-specific command
shell and lifecycle differences mean the full Windows suite is not yet a release
gate.

## Requirements

- Node.js `>=22.19 <27`
- pnpm `11.25.0` (building from source; not required for the packaged installer)
- Git
- a Bash-compatible shell for the existing cross-platform workflow
- `ffmpeg` for optional image/ROS2 image previews (required if using those tools)

For the fully supported production path, use Linux. macOS and Windows can
use the portable Node/npm install flow; do not assume those hosts have passed
all Linux-only subprocess and sandbox tests. See
[`PORTABLE_DEPLOYMENT.md`](docs/PORTABLE_DEPLOYMENT.md) for verified
capabilities, limits, side-by-side upgrades and rollback.

## Install an immutable release (recommended)

For Linux, macOS and Windows, the portable installer stages a fixed published
release under the current user's data directory and leaves existing services
untouched. After obtaining the repository's deployment scripts:

```bash
node deploy/portable-install.mjs --plan --version 0.4.0
node deploy/portable-install.mjs --stage --version 0.4.0
node deploy/portable-install.mjs --activate --version 0.4.0
```

These commands require that `v0.4.0` has actually appeared in
[GitHub Releases](https://github.com/yuezhihuafou/synrex/releases).
For earlier releases, substitute the published version. See
[`PORTABLE_DEPLOYMENT.md`](docs/PORTABLE_DEPLOYMENT.md) for user-local
launchers, offline archives, OS autostart, multi-node setup and rollback.

## Install from source (development)

```bash
git clone https://github.com/yuezhihuafou/synrex.git
cd synrex
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

This installer is **first-install only**: it refuses to overwrite an existing
`devspace.service`. Upgrade an existing self-hosted installation using the
immutable release, owner-state backup, validation and rollback procedure in
[`SINGLE_OWNER_SELF_HOSTED.md`](docs/platform/SINGLE_OWNER_SELF_HOSTED.md).

For a first demonstration, see [Setup Guide](docs/setup.md),
[Portable Deployment](docs/PORTABLE_DEPLOYMENT.md) and
[Public Demo Guide](docs/launch/PUBLIC_DEMO.md). Do not demonstrate against
private repositories, real tokens, or a publicly accessible unauthenticated
shell.

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
