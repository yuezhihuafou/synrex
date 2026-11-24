# Decision: node-local external MCP mounts

**Status:** Experimental in Synrex 0.4.6; not deployed or released.

## Context

Synrex already uses the MCP SDK for dedicated integrations such as Serena over stdio and MemHub over Streamable HTTP. It did not yet provide a general owner-configured way to connect arbitrary external MCP servers. AgentDesktop must run on the machine whose graphical session it controls, while the public Synrex MCP endpoint may live on a different node.

## Decision

Add a local `McpMountManager` per Synrex node. It reads owner-managed configuration and supports stdio and Streamable HTTP transports. Connections are lazy and reused. The manager discovers remote tool schemas and invokes only advertised tool names.

Expose one compact workspace-scoped Synrex tool with three modes:

- `mcp_mount({ workspaceId })`: list local configured mounts without revealing connection details or secrets.
- `mcp_mount({ workspaceId, request: JSON.stringify({ server }) })`: discover the remote tool catalog and JSON input schemas.
- `mcp_mount({ workspaceId, request: JSON.stringify({ server, tool, arguments }) })`: invoke one remote tool and pass through its MCP result.

All three tools include `workspaceId`. The existing `withMultiNodeRouting` and peer `ToolInvoker` remain the only cross-node execution path. The node that owns the workspace launches or connects to its own MCP server. No new coordinator or agent runtime is introduced.

## Safety and lifecycle

- Mount definitions are owner configuration only; models cannot add commands, headers, or environment variables.
- HTTP endpoints must use HTTPS or loopback HTTP and cannot embed URL credentials.
- Secrets are omitted from list output and redacted from connection errors.
- Remote tool calls are treated as open-world and potentially destructive.
- A failed call is never automatically replayed because the remote operation may already have taken effect.
- Healthy clients are reused; failed transports are invalidated; all clients are closed during Synrex shutdown.
- Remote catalogs and results are size-bounded.

## Consequences

The model discovers tools and invokes them through one compact generic proxy. This is less transparent than flattening every remote tool into Synrex's top-level tool list, but it avoids stale or conflicting schemas across nodes, keeps the default tool surface compact, and keeps execution on the correct machine. Direct per-tool exposure can be considered later if node-specific tool catalogs can be advertised safely.

The first transport set is stdio and Streamable HTTP. SSE-only transports and automatic OAuth discovery are deferred.

## Verification

The implementation is tested in an isolated 0.4.6 Gateway checkout using real stdio and Streamable HTTP MCP fixtures, environment isolation, connection reuse/invalidation, workspace ownership checks, and a multi-node routing test. The actual AgentDesktop integration was then exercised on swy1, the supported desktop owner: Ubuntu 24.04.5, AgentDesktop 1.3.1, X11 virtual display `:38`, and a granted AT-SPI bus. A temporary harness loaded this checkout's compiled `McpMountManager` and `mcp_mount` registration code. Sixteen stdio MCP instances with 16 unique agent IDs shared one AgentDesktop session; all connected, each exposed 75 tools, and all 16 `desktop_status` calls passed. Two agents returned distinct snapshot IDs for the same Calculator window. A headless semantic click through `mcp_mount` was read back as Calculator value `1`, then the test restored the display.

The Gateway host itself is Ubuntu 22.04.5; AgentDesktop 1.3.1's Linux installation requirements specify Ubuntu 24.04 or later, so it is not a supported AgentDesktop execution host. Keep the AgentDesktop process on swy1's virtual desktop or upgrade Gateway before attempting a local install. The Windows peer was offline and no macOS peer was available, so three-platform acceptance is not claimed. The integration harness was temporary; the active immutable Synrex 0.4.6 release on swy1 still does not contain `mcp_mount`. No production service, owner config, or release was modified.
