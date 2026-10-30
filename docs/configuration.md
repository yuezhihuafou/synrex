# Configuration Reference

Synrex stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/yuezhihuafou/synrex/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "node": {
    "alias": null,
    "labels": {},
  },
  "cluster": {
    "role": "standalone",
    "gatewayUrl": null,
    "requestTimeoutMs": 180000,
    "pollWaitMs": 25000,
    "heartbeatMs": 15000,
    "suspectAfterMs": 45000,
    "offlineAfterMs": 120000,
    "placementRules": [],
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
    "metadataRetentionDays": 90,
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "instructions": "on-demand",
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

## Multi-node execution

Synrex keeps one MCP tool surface while a gateway routes workspaces to local
or remote Synrex runtimes. Node selection occurs when opening a workspace;
later calls stay sticky to that workspace owner.

On the MCP-facing host:

```bash
devspace nodes gateway
```

This creates a bootstrap join token in `auth.json` and switches
`cluster.role` to `gateway`. Restart Synrex after changing roles. On another
host, join using the gateway's HTTPS origin, without `/mcp`:

```bash
devspace nodes join https://devspace.example.com --token <join-token> --alias gpu-box
```

The join token bootstraps registration. The gateway returns a distinct
per-node credential, which the worker stores in its own `auth.json`. The worker
maintains an outbound long-poll connection, so it does not need an additional
public inbound port.

Operational commands:

```bash
devspace nodes list
devspace nodes drain gpu-box
devspace nodes undrain gpu-box
devspace nodes join-token
```

`drain` blocks new workspace placement while preserving existing ownership.
Remote node health degrades from `online` to `suspect` and then `offline` when
heartbeats stop. Heartbeat loss alone never marks a durable task failed;
execution truth remains on the owning node.

The MCP `open_workspace` tool has one optional node id/alias selector. Other
tools continue to route only by `workspaceId`, so adding nodes does not expand
every tool schema.

Placement is deliberately fail-closed for stateful workspaces. Synrex first
uses hard project rules and advertised workspace roots; it auto-selects a node
only when the result is unique. If two nodes can host the same path, it returns
the candidates instead of silently choosing one. The model should normally omit
`node` and retry with an explicit selector only when the user's intent identifies
the host.

For paths where choosing the wrong host would be costly, add a required rule:

```jsonc
{
  "node": {
    "alias": "robot",
    "labels": { "role": "robot", "site": "lab" },
  },
  "cluster": {
    "placementRules": [
      {
        "id": "robot-workspace",
        "pathPrefix": "/home/swy/ros2_ws",
        "mode": "require",
        "labels": { "role": "robot" }
      }
    ]
  }
}
```

`require` is a hard constraint: even an explicit model-selected node is rejected
when it violates the rule. `prefer` only disambiguates the default placement and
may be overridden by an explicit node selector. Use `require` for robot hardware,
unique datasets, licensed environments, or other host-sensitive work; use
`prefer` for interchangeable development clones.

Node bootstrap credentials are intentionally excluded from `config.jsonc`.
They live in `auth.json`; managed deployments may override them with
`DEVSPACE_NODE_JOIN_TOKEN` and `DEVSPACE_NODE_TOKEN`.

`oauth.allowedResourceUrls` accepts exact alternate MCP resource URLs for
clients that connect through a resource alias, such as a secure MCP tunnel.
The normal `server.publicBaseUrl` `/mcp` resource remains allowed automatically.
Configure the complete alias URL, not a hostname or origin; aliases do not
change OAuth discovery URLs or proxy routing.
Resource URLs must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`,
or `[::1]`, with optional ports. Restart Synrex after changing
`oauth.allowedResourceUrls`: the provider reads this policy at server creation.
After restarting, refresh tokens for removed aliases can no longer mint tokens.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. Core workspace/edit/command/review tools plus the stable `project`, task-lifecycle, and semantic code tools. Semantic tools stay registered even when the local Serena backend is unavailable, so the host-facing schema does not change across restarts. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

Synrex attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

`storage.metadataRetentionDays` controls cleanup of stale checkout workspace
sessions, old conversation bindings, and their Git-backed review refs. Active
managed worktrees are never deleted by this metadata cleanup; the separate
managed-worktree pruning policy remains responsible for their filesystem
lifecycle.

The `project` tool intentionally keeps its `action` field open-ended while
strongly typing the durable high-frequency architecture fields. `action=help`
discovers operations, and `args` is the forward-compatible extension slot.
This lets most project-intelligence features evolve without changing the
top-level MCP tool list or invalidating a host's cached action enum.

## Skills and subagents

Synrex discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

When Subagents are enabled for MCP workspaces, Synrex keeps its bundled
`subagents` skill synchronized at `~/.devspace/skills/subagents/SKILL.md`.
That managed copy is the authoritative `subagents` skill for Synrex and is
refreshed when the packaged skill changes.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "instructions": "on-demand",
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

`subagents.instructions` controls when ChatGPT receives the managed workflow:

| Value | Behavior |
| --- | --- |
| `on-demand` | Default. `open_workspace` advertises the `subagents` skill and the model reads it only when the task benefits from delegation. |
| `preload` | `open_workspace` includes the `subagents` workflow in its initial workspace instructions instead of advertising that skill for a separate read. |

Both modes only make the workflow available; neither tells the model to prefer
subagents for routine work.

### Generic headless CLI providers

New headless tools can be registered through configuration instead of adding a
TypeScript adapter for every vendor. For example, a CLI that accepts a model,
session ID, prompt, and emits JSON lines with a final `result` event:

```jsonc
{
  "subagents": {
    "enabled": true,
    "providers": [
      { "id": "antigravity", "enabled": true, "model": "gemini-3.8-flash-medium" },
      {
        "id": "custom-agent",
        "enabled": true,
        "cli": {
          "command": "/path/to/custom-agent",
          "args": ["--output-format", "stream-json"],
          "outputFormat": "stream-json",
          "modelFlag": "--model",
          "promptFlag": "--print",
          "sessionFlag": "--conversation",
          "successStatus": "SUCCESS",
          "responseField": "response",
          "sessionField": "conversation_id"
        }
      }
    ]
  }
}
```

CLI arguments are passed directly, without a shell. The provider's streaming
event names and usage counters are retained as bounded structured metadata,
without recording raw model reasoning or entire tool outputs. `synrex agents
events <id> [after-seq] --json` permits incremental polling; `synrex agents
watch <id> --json` tails an active agent; `synrex agents stats --json` returns
per-workspace turn outcomes, durations and **reported** token counts (`null`
when the provider did not supply them). Data is stored in the existing Synrex
SQLite database, not a second service.

The bundled Antigravity profile uses the generic CLI driver, `agy` stream-json,
and native `conversation_id` / `--conversation` continuation. It also uses a
verified Linux mount namespace for filesystem isolation. Each AGY agent keeps
a private state copy under `<stateDir>/subagent-cli-sessions/<agentId>` so
resuming a conversation does not lose the CLI's local history; this copy may
include authentication state. The directory is owner-only and does **not**
modify the canonical AGY login. It uses extra disk space until the owner
cleans up retired agent state. Other generic CLIs run under the current user;
the generic driver rejects `read_only` unless an explicit isolation mechanism
exists. An arbitrary CLI configuration is not itself a sandbox.

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

Provider executable discovery remains process-scoped. The supported overrides
are `CODEX_COMMAND`, `CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`,
`COPILOT_COMMAND`, `GROK_COMMAND`, `GROK_AGENT_PROFILE`, `ANTIGRAVITY_COMMAND`,
and `ANTIGRAVITY_MODEL`. Synrex does not provision provider credentials; the
AGY isolation behavior above retains an owner-only copy of existing CLI state.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Environment boundary

Only two user-facing Synrex environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file Synrex can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, Synrex never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
