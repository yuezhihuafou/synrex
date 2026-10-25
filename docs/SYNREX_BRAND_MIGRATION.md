# Synrex product rename and compatibility contract

Synrex is the current public product name. Rev and DevSpace Verge are
historical product names, not supported aliases for new public marketing copy.
Retain explicit upstream attribution to Waishnav/devspace and MIT notices.

## User-facing names

| Surface | Current name | Compatibility retained |
| --- | --- | --- |
| Product and documentation | Synrex | Historic names only for provenance |
| MCP server title/name | Synrex / synrex | Stable MCP URL, OAuth issuer and tool names |
| Primary CLI | synrex | devspace still invokes the same runtime |
| Console, OAuth and cards | Synrex | Existing routes, cookies and authorization |
| Subagent Skill | Synrex subagents | Skill id, older install/config locations |
| npm package metadata | synrex (not published) | devspace executable and data layout |
| Product charter | docs/PRODUCT_CHARTER.md | Historical release evidence retained |
| Roadmap | docs/SYNREX_PRODUCT_ROADMAP.md | Old histories may still refer to Rev |

## Technical identifiers retained deliberately

- DEVSPACE_* environment variables, ~/.devspace state roots, database and
  systemd names and refs/devspace/... Git references are installed contracts.
- The active public MCP/OAuth issuer and domain, existing client tokens,
  refresh tokens, Console cookie name and session HMAC version are continuity
  and security contracts. Existing sessions must survive a UI-only rename.
- The canonical GitHub repository is `yuezhihuafou/synrex`. The former
  `yuezhihuafou/devspace-verge` slug is historical; use the canonical URL for
  installation, metadata, configuration schemas, and Git remotes.
- Historic pinned releases and workflow titles remain audit evidence. Never
  rewrite immutable release manifests or user task histories for branding.
- Tool events such as rev_http_completed are historical durable diagnostic
  schema; retain the keys and display the new brand in the UI.

## Release acceptance

1. Build/typecheck and run full tests including package-install smoke.
2. Verify synrex --version and devspace --version from one package, and
   MCP initialization advertising synrex.
3. Verify OAuth UI copy without issuer, refresh-token, route or cookie changes.
4. Inspect /console signed login and read-only dashboard behavior.
5. Establish reproducible immutable candidate from auditable source, verify
   with disposable state and authenticated HTTP MCP, back up production,
   promote with health and rollback checks, then verify the actual host.

Source verification uses `pnpm release:source-check`; use
`pnpm exec tsx scripts/check-release-source.ts --report` for read-only
diagnostics when the gate is blocked. The legacy mutable `pnpm deploy:live`
shortcut now fails closed. Retain real Git and historical release evidence;
do not rewrite old manifests to simulate a clean source baseline.

Development checkouts may contain uncommitted changes at any time.
Do not replace the pinned production release from mutable source via
pnpm deploy:live or silently change OAuth authority for a brand-only release.

The installed ChatGPT plugin's display description belongs to its host UI.
Use docs/PLUGIN_DESCRIPTION.md for copy. Updating MCP server metadata does not
force an already-open ChatGPT conversation to refresh its tool snapshot.
