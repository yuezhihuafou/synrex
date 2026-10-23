# Contributing to Synrex

Synrex is an early-stage, independently maintained derivative of [Waishnav/devspace](https://github.com/Waishnav/devspace). Issues, reproducible bug reports and focused pull requests are welcome. Maintainer capacity is limited; please open an issue before starting a large change.

## Helpful contributions

- Reproducible reliability, recovery and multi-host bugs, with relevant versions, redacted logs and steps.
- Small fixes with a regression test where practical.
- Documentation and installation improvements, especially independent self-hosted setup reports.
- Paired, reproducible benchmarks with model, effort, starting commit and environment identified.

## Before submitting a PR

1. Describe the problem and scope; keep unrelated changes separate.
2. Run `pnpm typecheck` and relevant tests, or document why they could not be run.
3. For UI changes, attach before/after screenshots. Never attach passwords, access tokens, private hostnames or production databases.
4. Preserve the inherited MIT license and upstream attribution, and respect the existing architecture and compatibility contracts.

The project is primarily developed and release-tested on Linux; macOS has a CI smoke path and Windows is currently best-effort. Review and merge are not guaranteed.
