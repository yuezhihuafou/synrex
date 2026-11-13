# Changelog

Synrex's version numbers are independent of the upstream DevSpace project.
Only verified release artifacts, tags and running manifests identify deployed
versions; a changelog entry alone does not prove that a release was published.

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
