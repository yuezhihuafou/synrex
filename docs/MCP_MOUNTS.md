# External MCP mounts

Synrex can act as an MCP client for owner-configured external MCP servers. A mount is local to the Synrex execution node that reads its configuration. When a model supplies a `workspaceId`, the existing multi-node router sends the MCP request to the node that owns that workspace; the external server process is therefore started on the correct machine.

## Configure a server

Add an `mcp.servers` entry to that node's Synrex configuration. Replace the command and arguments below with the MCP stdio entrypoint documented by the server you are mounting:

```json
{
  "mcp": {
    "servers": [
      {
        "name": "agent-desktop",
        "transport": "stdio",
        "command": "/absolute/path/to/the-mcp-server",
        "args": [],
        "enabled": true,
        "timeoutMs": 30000
      }
    ]
  }
}
```

Supported transports:

- `stdio`: launches the configured executable directly, without a shell. `command`, `args`, optional `cwd`, and optional `env` are controlled by the local owner.
- `streamable-http`: connects to an HTTPS endpoint, or an HTTP loopback endpoint. Optional static headers are read from the local owner configuration.

Stdio children inherit the MCP SDK's small safe environment baseline plus graphical-session variables needed by desktop servers. Other parent-process variables, including ambient API tokens, are not forwarded unless the owner explicitly adds them under `env`. Child stderr is drained without forwarding it into Synrex logs.

Mount definitions are not accepted through model tool arguments. The configuration supports at most 16 servers per node; names must be unique. Connection timeouts are bounded between 500 ms and 120 seconds. URL credentials are rejected. Secrets in configured headers and environment variables are not returned by discovery tools.

## Discover and call tools

Use the workspace identity to select the execution node:

1. `mcp_mount({ workspaceId })` lists configured mounts on that node without exposing commands, URLs, headers, or environment variables.
2. `mcp_mount({ workspaceId, request: "{\"server\":\"agent-desktop\"}" })` connects lazily and returns the remote tool names, descriptions, and JSON input schemas.
3. `mcp_mount({ workspaceId, request: "{\"server\":\"agent-desktop\",\"tool\":\"desktop_snapshot\",\"arguments\":{...}}" })` invokes one advertised remote tool and passes its MCP result through unchanged.

`mcp_mount` is marked as open-world and potentially destructive because the remote server runs with the execution node's permissions. Inspect the tool schema before calling it. Remote tool calls are not automatically replayed after an uncertain transport failure. The manager reuses healthy connections, invalidates failed connections, and closes them when Synrex shuts down.

Remote tool descriptions and schemas are untrusted metadata. They do not override Synrex policy or the user's instructions.

## AgentDesktop multi-agent setup (tested on swy1)

AgentDesktop fixes `--session` and `--agent-id` when each MCP server process starts. Therefore use **one mounted stdio server per agent identity**, not one shared MCP process for all agents. Create one long-lived AgentDesktop session and reuse its ID across the mounts:

```sh
source "$HOME/.local/state/computer-bridge/virtual-v2/bus.env"
export DISPLAY=:38 XDG_RUNTIME_DIR="/run/user/$(id -u)" XDG_SESSION_TYPE=x11
agent-desktop session start --name synrex-agentdesktop --cursor --multi-agent --no-trace
```

Use the returned `data.session_id` in every mount, with a distinct `--agent-id` and Synrex server name for each agent. A small swy1 wrapper for the isolated virtual display (the inline equivalent was used in the integration test) is:

```sh
#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.local/state/computer-bridge/virtual-v2/bus.env"
export DISPLAY=:38 XDG_RUNTIME_DIR="/run/user/$(id -u)" XDG_SESSION_TYPE=x11
exec "$HOME/.nvm/versions/node/v22.22.2/lib/node_modules/agent-desktop/bin/agent-desktop" "$@"
```

Example mount (repeat with `agent-02`/`agent02` through `agent-16`/`agent16`):

```json
{
  "name": "agent-01",
  "transport": "stdio",
  "command": "/home/swy/.local/bin/agent-desktop-mcp-virtual",
  "args": ["--session", "<shared-session-id>", "--agent-id", "agent01", "mcp"],
  "cwd": "/home/swy",
  "enabled": true,
  "timeoutMs": 30000
}
```

Do not pass `--headed` for background operation. AgentDesktop's default is strict headless semantic delivery; on Linux X11, `--cursor --multi-agent` gives each agent a separate cursor identity. The agents still share one virtual desktop and application state: AgentDesktop arbitrates UI interactions rather than providing 16 independent operating systems or 16 simultaneous physical input streams. Each agent must use refs from its own fresh snapshot. The 16-server configuration limit is per node and leaves no slots for other MCP mounts on that node. AgentDesktop MCP instances also have their own bounded concurrency; Synrex and the desktop interaction lease impose further limits.

**Verified integration evidence:** on swy1 (Ubuntu 24.04.5, AgentDesktop 1.3.1), a temporary harness loaded this checkout's compiled `McpMountManager` and `mcp_mount` registration code. Sixteen stdio MCP instances connected with 16 distinct agent IDs in one `:38` virtual session; all 16 exposed 75 tools and passed `desktop_status` with AT-SPI granted. Two agents produced distinct snapshot IDs for the same Calculator window. A semantic `desktop_click` through `mcp_mount` changed the Calculator display to `1`, verified through `desktop_get`, and the test restored the display afterward. This was an isolated integration harness, not a deployment of `mcp_mount` into the live Synrex service.

AgentDesktop 1.3.1's Linux requirements specify Ubuntu 24.04 or later. The Gateway host is Ubuntu 22.04.5 and is not a supported AgentDesktop target; keep AgentDesktop on swy1's supported virtual desktop unless Gateway is upgraded. The Windows execution node was offline during this test, and no macOS node was available, so cross-platform acceptance remains separate work.

## Scope and limitations

- This is a generic MCP proxy, not a second agent or task orchestrator.
- Remote tools are discovered and invoked through `mcp_mount`; they are not flattened into separate top-level Synrex tool names in this iteration.
- The initial transport set is stdio and Streamable HTTP. SSE-only servers and automatic OAuth discovery are not included.
- Each node must have its own local mount configuration and required executable/runtime. A mount configured on the gateway is not implicitly available on swy1.
- AgentDesktop's own accessibility permissions, graphical session, and platform limitations still apply. A successful MCP handshake does not prove that the operating system can operate a desktop.
