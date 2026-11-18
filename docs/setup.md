# Setup Guide

This guide covers ChatGPT and Coding Agents using Synrex with local projects.

For a version-pinned, non-destructive installation or upgrade across Linux,
macOS and Windows, start with the
[portable deployment guide](PORTABLE_DEPLOYMENT.md). The source-build steps
below remain useful for development but are not a production-upgrade shortcut.

**Windows PowerShell:** Node.js 24 does not always include Corepack. For a
regular deployment use the portable installer (it bootstraps pinned pnpm via
npx). If building source intentionally, use `npm.cmd install -g
pnpm@11.25.0`, then `pnpm.cmd install --frozen-lockfile`,
`pnpm.cmd build`, and `npm.cmd link`. Do not clone again if
the source folder already exists.

## Requirements

- Node `>=22.19 <27`
- pnpm `11.25.0`
- Git
- Bash, including Git Bash or WSL on Windows
- `ffmpeg` when using screenshot/image previews or the optional ROS2 image reader
- a public HTTPS URL that forwards to the local Synrex server, only when
  ChatGPT will connect

Synrex does not create the public tunnel for you. ChatGPT users can use
Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse
proxy.

## Install And Configure

Synrex is currently distributed from its GitHub repository rather than npm:

```bash
git clone https://github.com/yuezhihuafou/synrex.git
cd synrex
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
npm link
```

Then initialize it:

```bash
synrex init
```

The setup flow asks one question at a time.

First choose where you will use Synrex: ChatGPT, Coding Agents, or both.
Synrex uses that answer to skip setup that does not apply to you.
Use Up/Down and Enter to select the one usage mode. Only the optional
Coding Agents provider selector uses **Space** to toggle multiple choices
before Enter. `init` is for first-time setup; `init --force`
reopens the wizard while retaining the existing Owner password.

### Project roots

If you selected ChatGPT, choose the project folders it may open through
Synrex. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

A Coding Agents-only setup skips this question. Direct `devspace agents`
commands use the current Git project, or the current directory outside a
repository, with the authority of your local shell. MCP workspace operations
remain limited to the roots configured for ChatGPT.

On Windows, prefer `D:\Projects` over the installation directory
on C:. The wizard offers D: as a default when present and asks before
creating a missing directory. Projects inside an existing allowed root do
not require another `init`. For additional roots:

```powershell
synrex.cmd config roots list
synrex.cmd config roots add 'D:\Research'
synrex.cmd config roots remove 'D:\OldProjects'
```

Restart Synrex after editing roots. Allowed roots restrict workspace entry;
Shell commands still run with the Windows user's permissions.

### Coding Agents

Setup detects supported Coding Agents and asks which ones Synrex may use.
These choices are stored as provider objects under `subagents` in
`~/.devspace/config.jsonc`.

If you selected Coding Agents, install the Synrex subagents skill from GitHub:

```bash
npx skills add yuezhihuafou/synrex --skill subagents --global
```

The Skills CLI asks which installed Coding Agents should receive the skill.
The skill uses `devspace agents targets`, `run`, `continue`, `show`, and `ls`.
These commands do not require `devspace serve`.

This Coding Agent installation is separate from ChatGPT MCP usage. For MCP
workspaces with Subagents enabled, Synrex manages its own copy at
`~/.devspace/skills/subagents/SKILL.md`; users do not install that copy
manually.

### Connect ChatGPT

Setup only asks for a public URL if you selected ChatGPT. Start your tunnel or
reverse proxy first and point it at:

```text
http://127.0.0.1:7676
```

For Tailscale Funnel, proxy the whole Synrex server from the root path:

```bash
tailscale funnel --bg 7676
```

Do not mount Funnel only at `/mcp` with `--set-path=/mcp`. Synrex also serves
OAuth discovery and authorization routes outside `/mcp`, and a path mount can
strip `/mcp` before the request reaches Synrex.

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

Protocol compatibility is automatic. Synrex serves MCP 2026-07-28 requests
directly and handles older 2025-era clients statelessly on the same endpoint;
there is no client-protocol setting to maintain.

A Coding Agents-only setup skips this section.

## Start The Server

Run:

```bash
synrex serve
```

If your tunnel URL changes, update the persisted value before starting:

```bash
synrex config set publicBaseUrl https://your-tunnel-host.example.com
synrex serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, Synrex shows an Owner
password approval page. Enter the Owner password printed during setup.
This is the password generated **on this machine**, not the domain owner's
Cloudflare credentials or another Synrex installation's password. It persists
across service restarts and ordinary configuration changes.

The default config files are:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
synrex doctor
synrex doctor --connect
```

Run `--connect` after starting the server. An unauthenticated
HTTP 401 with a Bearer challenge means Synrex is reachable and protecting
the MCP endpoint. HTTP 502 suggests a broken origin forwarding path;
failed hostname resolution suggests DNS or a missing published Tunnel route.
A healthy Tunnel connector alone does not publish a public hostname.

For a fresh persistent Linux install, `deploy/install-user-service.sh`
installs a user service. It now **refuses** to overwrite an existing
`devspace.service`. For an existing self-hosted installation, follow the
versioned-release, backup, validation and rollback procedures in
[`SINGLE_OWNER_SELF_HOSTED.md`](platform/SINGLE_OWNER_SELF_HOSTED.md);
never reinstall from a mutable checkout over the live Owner service.

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

Local checkout development uses the pnpm version pinned in `package.json`:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

The source server uses an ignored checkout-local fork of your normal Synrex
configuration and SQLite state. It uses an isolated loopback OAuth origin and
does not copy live OAuth tokens into the QA database. See [Development and Manual QA](development.md)
for worktree switching, ChatGPT testing, and database migration workflows.
