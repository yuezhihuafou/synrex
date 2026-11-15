# Synrex security policy

Synrex exposes authorized project files and shell execution through an OAuth-protected MCP server. Treat access to a Synrex instance as remote code execution with the privileges of its service account.

## Supported releases

Only the newest stable patch release receives security fixes. Older releases, prereleases, and experimental branches are not supported. Check [Releases](https://github.com/yuezhihuafou/synrex/releases) for the current version. Do not assume a release candidate or Git branch is deployed on a particular host.

## Reporting vulnerabilities

Please **do not** publish exploit details, bearer tokens, OAuth secrets, accessible private endpoints, or customer databases in a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/yuezhihuafou/synrex/security/advisories/new) if that feature is enabled for this repository. If the private reporting entrypoint is unavailable, contact the maintainer privately through their GitHub profile before disclosing actionable details. A public issue is suitable only for non-sensitive hardening requests.

Include the installed version and source revision, affected platform, minimal reproduction, impact, and whether the vulnerable endpoint is reachable only locally or over public HTTPS. Redact credentials and personal data.

Security reports are reviewed on a best-effort, single-maintainer basis. **No fixed response time or paid support SLA is promised.** When a vulnerability is confirmed, fixes are published as new immutable releases; older tags and release archives are never rewritten.

## Deployment safety

- Run the service using a dedicated unprivileged user, with narrow workspace roots. File-tool allowlists do not sandbox shell execution.
- Keep exactly one public OAuth/issuer authority. Use HTTPS, a loopback-bound Core, and authenticated Console access.
- Prefer a private network for execution peers; do not expose raw shell, peer join credentials or SSH to the internet.
- Keep Owner credentials, SQLite and recovery backups outside versioned release directories. Protect them with owner-only permissions.
- Verify the release archive digest and the dependency lock before installation or upgrade. Preserve a rollback release and back up persistent state.
- Monitor dependency advisories and update promptly; a clean dependency scan does not prove every runtime or deployment path is secure.

See [security model](docs/security.md) and [single-owner production contract](docs/platform/SINGLE_OWNER_SELF_HOSTED.md).
