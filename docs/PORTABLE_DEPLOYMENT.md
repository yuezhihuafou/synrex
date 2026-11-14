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
| macOS | Same portable Node/npm installer; optional LaunchAgent | Install, smoke and service rendering must be tested per release before claiming production support |
| Windows 10/11 | Native Node/npm, Git Bash, optional user Scheduled Task | Native staging/activation/rollback tests; some shell/TTY features remain best-effort |

Use Node.js >=22.19 and <27, npm, Git and a Bash-compatible shell (Git Bash
on Windows). `ffmpeg` is an optional dependency for image previews. To
connect ordinary ChatGPT remotely, configure your **own** HTTPS tunnel and
OAuth origin. The portable installer does not create DNS, OAuth credentials
or a cloud account.

## Install a version without replacing a running service

Obtain this repository's `deploy/` scripts (for example with `git clone`).
After the desired version is published, run from the repository root:

```sh
node deploy/portable-install.mjs --plan --version 0.4.0
node deploy/portable-install.mjs --stage --version 0.4.0
node deploy/portable-install.mjs --activate --version 0.4.0
node deploy/portable-install.mjs --status
```

The first command is read-only. `--stage` installs the GitHub Release
tarball and its npm dependencies into a **new, versioned user directory**
without changing any service, configuration or active version pointer.
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
`synrex-0.4.0.tgz` on a connected machine and transfer it to that host.
Then use:

```sh
node deploy/portable-install.mjs --stage --version 0.4.0 --source ./synrex-0.4.0.tgz --sha256 THE_VERIFIED_64_CHAR_SHA256
```

Dependencies still need npm registry access or an already populated cache.
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
  `Start-ScheduledTask -TaskName Synrex.Portable`.

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
