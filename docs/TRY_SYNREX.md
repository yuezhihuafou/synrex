# Try Synrex (early access)

Synrex gives an ordinary ChatGPT conversation workspace-scoped engineering tools through a self-hosted MCP service. The reasoning model stays in ChatGPT. You operate the execution service and control its permitted project directories.

## Before you begin

Use a disposable project first. You need Linux, Node.js >=22.19 and <27, pnpm 11.25.0, Git and a Bash-compatible shell. A remotely reachable MCP endpoint and its authentication must be configured for remote ChatGPT access. This project does **not** provide hosted accounts, domains or credentials.

## Install

```bash
git clone https://github.com/yuezhihuafou/synrex.git
cd synrex
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
npm link
synrex init
synrex doctor
```

Follow [the self-hosted deployment guide](platform/SINGLE_OWNER_SELF_HOSTED.md) and [persistent service instructions](compact-runtime.md) before connecting the service to a remote model host. Run `synrex serve` after configuration, and set up your ChatGPT MCP connector with the authenticated endpoint you control.

## First exercise

Open a disposable repository through Synrex, ask ChatGPT to inspect its code and run a test, then try a small edit and re-run that test. A long command can return a durable task identity for later inspection. Review the file diff before accepting changes. Keep production secrets and physical hardware outside permitted roots during initial testing.

## Feedback

Please [open an issue](https://github.com/yuezhihuafou/synrex/issues) with the source commit, OS/Node version, exact reproduction, expected versus actual behavior and **redacted** diagnostics. This release is an early public test, not a claim of proven superiority over the upstream project.
