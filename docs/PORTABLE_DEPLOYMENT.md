# Synrex portable deployment: Linux, macOS and Windows

Synrex is a self-hosted AI execution layer, not a hosted relay. Each
installation owns its project directories and credentials. A multi-host
installation has exactly one public HTTPS MCP/OAuth **Owner**; additional
nodes are optional execution peers. Do not copy an Owner's SQLite or OAuth
secrets to a peer, or start a second public coordinator.

## Requirements and actual support

| Platform | Installation and runtime | Release acceptance |
| --- | --- | --- |
| Linux | Primary supported platform; optional user-level systemd | Full supported CI and isolated authenticated MCP tests |
| macOS | Locked pnpm portable installer bootstrapped via npm/npx; optional LaunchAgent | Native OS install, smoke and service rendering are release gates |
| Windows 10/11 | Native Node/npm, npx, Git Bash/tar and curl, optional user Scheduled Task | Native installation/activation tests are release gates; shell/TTY features remain limited |

Use Node.js >=22.19 and <27, npm/npx, tar, curl, Git and a Bash-compatible shell
(Git Bash on Windows). The installer bootstraps **exactly pnpm 11.25.0** with npx
and installs from the published `pnpm-lock.yaml` and `pnpm-workspace.yaml` using
`--frozen-lockfile`; this prevents unreviewed dependency re-resolution.
`ffmpeg` is an optional dependency for image previews. To
connect ordinary ChatGPT remotely, configure your **own** HTTPS tunnel and
OAuth origin. The portable installer does not create DNS, OAuth credentials
or a cloud account.

## Install a version without replacing a running service

Obtain this repository's `deploy/` scripts (for example with `git clone`).
After the desired version is published, run from the repository root:

```sh
node deploy/portable-install.mjs --plan --version 0.4.3
node deploy/portable-install.mjs --stage --version 0.4.3
node deploy/portable-install.mjs --activate --version 0.4.3
node deploy/portable-install.mjs --status
```

The first command is read-only. `--stage` verifies the GitHub Release
tarball against the published `SHA256SUMS`, then installs its **locked pnpm dependencies**
into a **new, versioned user directory**
without changing any service, configuration or active version pointer.
`--stage` extracts and validates the archive in a temporary directory, moves
the unpacked package to its final version directory, and **only then** runs
pnpm there. On Windows, pnpm's Junction targets can be absolute; moving a
fully installed `node_modules` tree afterwards would leave broken links
(`ERR_MODULE_NOT_FOUND` after an apparently successful install). The installer
checks `synrex --version` from the **final** path and removes a failed new
version without touching existing versions or the active pointer. An existing
version is also rechecked before `--stage` or `--activate` accepts it.
Child-process failures include their exit status and bounded stdout/stderr.
If an interrupted installation left a partial version directory, preserve
the current active release and diagnose or manually isolate that incomplete
directory before retrying; do not delete an existing active release.
`--activate` moves only the portable launcher's version pointer after
verifying the staged package. It does not restart a service. A previous
version remains available:

```sh
node deploy/portable-install.mjs --rollback
```

Default portable storage locations:

- Linux: `~/.local/share/synrex/portable`
- macOS: `~/Library/Application Support/Synrex/portable`
- Windows: `%LOCALAPPDATA%\Synrex\portable`

After activation, run `bin/synrex` on Unix or `bin\synrex.cmd` on
Windows from the portable prefix, then initialize and diagnose your setup:

```sh
synrex init
synrex doctor
synrex serve
```

Use the full portable launcher path if the `bin` directory is not in your
PATH. `synrex init` must be completed in the intended user account. In
multinode mode configure the single Owner and peer roles intentionally,
not from guessed network locations.

If your host cannot reach GitHub directly, download the official
`synrex-0.4.3.tgz` on a connected machine and transfer it to that host.
Then use:

```sh
node deploy/portable-install.mjs --stage --version 0.4.3 --source ./synrex-0.4.3.tgz --sha256 THE_VERIFIED_64_CHAR_SHA256
```

Dependencies and the exact pnpm bootstrap still need registry access or an already populated cache.
Offline archives are not falsely described as self-contained native bundles.

## Optional automatic startup

Generate the appropriate user-level service definition **only after activation**:

```sh
node deploy/portable-service.mjs --plan
node deploy/portable-service.mjs --write
```

It writes files under the portable prefix's `service/` directory and
**does not register, enable, start or overwrite an OS service**.

- **Linux:** inspect `synrex-portable.service`, then use
  `systemctl --user link ABSOLUTE_UNIT_PATH`,
  `systemctl --user daemon-reload`, and
  `systemctl --user enable --now synrex-portable.service` for a fresh
  installation.
- **macOS:** inspect `org.synrex.portable.plist`, then use
  `launchctl bootstrap gui/$(id -u) ABSOLUTE_PLIST_PATH` for a fresh
  user LaunchAgent.
- **Windows:** inspect `register-synrex-task.ps1` and run it in a local
  PowerShell session; it refuses to overwrite an existing
  `Synrex.Portable` task. Start it explicitly with
  `Start-ScheduledTask -TaskName Synrex.Portable`. The generated
  `start-synrex-hidden.vbs` launches the Node runtime without a visible
  console. Existing tasks (including independently maintained
  `Synrex.WinDirect` and `Synrex.SwyPublicMonitor`) are intentionally
  not modified by the portable installer; migrate those separately.

Do **not** enable a second Owner service on a host with an existing
`devspace.service`. For an existing pinned single-owner production
installation, upgrade through the audited `deploy/promote-main.sh`
procedure with state backup, authenticated tests and rollback; do not
replace its systemd unit from a source checkout. CLI portability and
production OAuth ownership are separate issues.

## Console and multi-host behavior

The source-backed Release includes both `dist/` (Core) and
`dist-console/` plus `dist-console-server/` (optional independent Console).
The Console needs its own Owner-authenticated, private runtime state and
loopback binding. It is **not** started by `synrex serve`, and installing
the package does not publish a privileged dashboard automatically.
Use `node dist-console-server/console-monitor.js` with its explicit
`--state-dir`, `--run-root`, `--monitor-dir`, and `--auth-file`
arguments, after reviewing `scripts/console-monitor.ts`.

For an existing Linux single-owner installation where the independent
`synrex-console.service` already runs, first promote the newly verified
immutable Owner Core. Only then use
`deploy/activate-synced-console.sh PINNED_RELEASE PRIVATE_BACKUP_DIR`.
This separate guarded operation preserves the effective Console startup
arguments, takes an online SQLite snapshot, verifies the new Console assets
against the source release manifest and automatically reverts the service
and database on a failed health check. It is **not** part of a portable
first-time installation and must not be used against an unverified build.

Different peers do not require identical runtime revisions, but must negotiate
supported capability and protocol contracts. An offline peer must never
make the sole Owner unusable. To diagnose a failure, check the actual
running manifest/version and tool result, not just the local Git branch.
