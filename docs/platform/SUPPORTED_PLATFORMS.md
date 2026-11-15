# Supported platform and runtime scope

| Platform | Packaging/install | Shell and execution | Official support |
| --- | --- | --- | --- |
| Linux (Ubuntu, Node >=22.19 <27) | Versioned release, native tests, production-pinned Owner | Full supported CI and isolated authenticated MCP; Linux-specific sandbox dependencies may be needed | Primary supported platform |
| macOS (GitHub-hosted native runner, Node 24) | Native release/installer tests and CLI/asset smoke | POSIX coding tools; no Linux bubblewrap parity claim | Tested portable install, limited operations support |
| Windows (GitHub-hosted native runner, Node 24) | Native release/installer tests and CLI/asset smoke | Git Bash required for POSIX commands; pty, service supervision, shell semantics may differ | Tested portable install, limited operations support |

The exact matrix is per-release evidence, not a perpetual guarantee. A passing packaging CI job does not mean an arbitrary user's workstation, SSH peer or public tunnel was tested. The experimental Windows laptop's scheduled task and the gateway compute peer are separate migrations.

**Support boundary:** single Owner, user-operated OAuth domain and local machines. No hosted service, automatic ChatGPT model continuation, device administration or guaranteed uptime. Check `synrex doctor` and the actual live process revision before reporting a platform as healthy.

**Maintenance policy:** latest stable patch only; immutable released archives and tags; changes to persistent format or public issuer require an explicit migration and rollback plan.

See [portable deployment](../PORTABLE_DEPLOYMENT.md), [self-hosted production](SINGLE_OWNER_SELF_HOSTED.md) and [security reporting](../../SECURITY.md).
