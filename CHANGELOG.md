# Changelog

Synrex's version numbers are independent of the upstream DevSpace project.
Only verified release artifacts, tags and running manifests identify deployed
versions; a changelog entry alone does not prove that a release was published.

## 0.4.0 — historical-feature consolidation candidate (2026-11-14)

- Incorporated the previously isolated workspace lifecycle P1–P4 into the
  current Core: cross-conversation workflow-to-worktree recovery, bounded
  leases, read-only worktree state/detail and conservative Git-safe retention.
- Replaced experimental startup/periodic GC with read-only startup inspection.
  Browser GC is **preview-only**; actual pruning requires an explicit local
  `synrex worktrees prune --execute` and proven completed workflow ownership.
  Legacy unknown/dirty/active worktrees remain protected, never mass-reset.
- Detects a stale Console snapshot which claims an older immutable Core
  release, independently of snapshot freshness timestamps.
- Ensures separately activated Console instances display the newly verified
  release identity rather than retaining an obsolete label.
- Adds read-only local disk-capacity warning/critical status in independent
  Console; never infers remote disk state or deletes files.
- Adds Git history/worktree read-only audit, a feature decision ledger and
  mocked multiline Antigravity compatibility regression.

This is **not** a claim that all optional host environments are identical or
that an offline gateway/macOS host has passed live acceptance. The pinned
production receipt and published tag are the source of truth for deployment.

## 0.3.0 — consolidated portable-release candidate (2026-11-13)

- Replayed the independently deployed Console's eight verified monitoring,
  SSH peer metrics, SQLite backfill, node-status and Tunnel incident commits
  on top of the existing v0.2.0 Core without downgrading it.
- Builds and packages independent Console static assets and server alongside
  Core from the same source revision, while retaining separate processes,
  authentication and failure domains.
- Adds a dedicated, guarded Console activation path for an already-running
  pinned Owner Core, with a consistent monitor SQLite backup and rollback.
- Carries forward the bounded optional Cloudflare Tunnel watchdog and tests;
  it is never a mandatory dependency of Core or the portable installer.
- Adds a cross-platform user-local, side-by-side installation tool, explicit
  version activation/rollback, and additive Linux/macOS/Windows service
  definition generation without replacing existing services.
- Adds Linux/Windows-native portable installer tests and package-content
  verification. macOS runtime remains to be separately verified.
- Documents development/production integration decisions while retaining
  older worktrees and unpublished experiments for review.

The v0.3.0 line is **not** an implicit promise of fully supported macOS or
Windows deployments. CI, actual tagged release and production manifest
establish which builds passed which gates.

## 0.2.0 — public-preview release candidate (2026-11-13)

- Consolidated the single-owner, GPT-led coding product scope and public
  installation, first-run and demonstration guidance.
- Added a guard preventing the first-install helper from overwriting an
  existing live or configured `devspace.service`. Existing pinned-release
  deployments must use the reviewed backup/verification/rollback path.
- Added a standalone, deliberately failing example to demonstrate a real
  ChatGPT → Synrex → test → review workflow.
- Fixed provider-mock tests that depended on a developer's private login;
  image tests now explicitly identify missing optional `ffmpeg` as a skip.
- Carries forward verified main-branch developments since the earlier public
  preview, including durable execution, workspace recovery, multi-node and
  authenticated Console capabilities. Individual capability support depends on
  the exact installed release and client tool surface.

**Limits:** single-owner/self-hosted; Linux primary; Windows best-effort;
external HTTPS/OAuth setup required for remote ChatGPT; no autonomous
continuation of ChatGPT reasoning after a disconnected chat. No comparative
performance or reliability superiority is claimed without controlled evidence.

## 0.1.0 — first public preview (2026-10-23)

- Initial independent Synrex public-preview release with retained upstream
  DevSpace attribution and MIT licensing.
