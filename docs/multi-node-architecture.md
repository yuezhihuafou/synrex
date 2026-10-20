# Multi-node architecture

Synrex is evolving from a single-machine MCP execution server into a
single-user, multi-node development execution fabric. The public host keeps one
stable tool surface while workspaces remain owned by the machine that actually
holds their filesystem, processes, language servers, architecture observations,
credentials, and durable task runners.

The design target is deliberately asymmetric: architecture for roughly twenty
heterogeneous nodes, implementation for the current two-machine deployment.
Synrex does not attempt to become a general cluster scheduler.

## Invariants

1. Existing single-node behavior remains the compatibility baseline. A default
   installation still opens local workspaces and exposes the same tools.
2. The model receives one MCP endpoint. Adding nodes must not multiply the
   host-facing tool schema or add a node/host argument to every tool.
3. A workspace has one execution owner at a time. Workspace filesystem,
   processes, LSP/Serena state, observed architecture state, local agents, and
   task runners remain node-local.
4. The control plane owns only globally useful coordination state: node
   registry, workspace routes, task routes, conversation bindings, health, and
   placement metadata.
5. Network loss is not task failure. Durable work continues on the owning node;
   reconnect performs reconciliation.
6. Architecture intent is project state and may travel through Git. Observed
   architecture/LSP state is a workspace snapshot and must not be merged across
   nodes or revisions as though it were one truth.
7. Transport is an adapter. Workspace/task semantics must not depend on SSH,
   WebSocket, QUIC, WireGuard, a tunnel provider, or a particular cloud.
8. Protocol versions and capability negotiation are explicit from the first
   multi-node release.

## Logical model

```text
AI host (ChatGPT / Claude / Codex)
                |
          one MCP endpoint
                |
      +---------v----------+
      | Synrex Gateway   |
      | control plane      |
      |--------------------|
      | auth               |
      | node registry      |
      | workspace directory|
      | task directory     |
      | placement          |
      | protocol routing   |
      +----+-----------+---+
           |           |
       node RPC     node RPC
           |           |
   +-------v---+   +---v-------+
   | Node A    |   | Node B    |
   | runtime   |   | runtime   |
   |-----------|   |-----------|
   | filesystem|   | filesystem|
   | git       |   | git       |
   | processes |   | processes |
   | tasks/logs|   | tasks/logs|
   | LSP/Serena|   | LSP/Serena|
   | Normify   |   | Normify   |
   | subagents |   | subagents |
   +-----------+   +-----------+
```

The existing Synrex server is treated as the node runtime rather than being
split into remote variants of every file/process/LSP feature. The future
gateway forwards the existing tool contract to the owning node and rewrites
only opaque global identity. This is what preserves current features while
keeping the model-facing schema compact.

## Identity and ownership

### Node

Every runtime receives a stable opaque `node_*` identity persisted in the
Synrex state directory. A mutable human alias such as `desktop`, `gpu`, or
`robot` is separate from identity. Capabilities include platform, resources,
labels, tool mode, and feature names. A node also advertises a protocol major
and minor version.

### Project and workspace

A project is repository/logical identity. A workspace is a concrete checkout
or worktree snapshot on one node:

```text
Project
  +-- Workspace A @ Node 1 / commit X
  +-- Workspace B @ Node 2 / commit X
  +-- Workspace C @ Node 2 / dirty commit Y
```

Global workspace IDs are gateway-owned opaque handles. The workspace directory
maps them to `{ nodeId, localWorkspaceId }`. Existing standalone mode uses the
same local workspace ID externally, preserving compatibility.

### Task and run

Tasks and run logs are execution-owned. The control plane may index
`{ taskId, nodeId, workspaceId, localTaskId, runId }`, but PID, systemd unit,
output path, heartbeat, and full logs remain on the node. This keeps the
current durable-task recovery model authoritative.

## Routing

Only `open_workspace` participates in placement. Once opened, all later tools
route by workspace ID; the model never repeatedly chooses a host.

Stateful workspace placement is deterministic and fail-closed. The resolver
uses the following evidence in order: required path/label rules, a unique
advertised workspace-root match, preferred rules for disambiguation, and an
explicit node selector when user intent requires a particular host. Explicit
selectors are still checked against node health, advertised roots, and required
rules. Ambiguity returns an error with candidate nodes instead of silently
falling back to the gateway/local machine.

This intentionally separates **hard constraints** from **soft preferences**.
Hard rules protect robot hardware, unique data, licensed environments, and
other host-sensitive state. Soft rules are appropriate only when multiple
workspace replicas are genuinely interchangeable. A future stateless scheduler
may add resource scoring/bin-packing, but stateful workspaces remain sticky.

## Node lifecycle

Nodes move through `online -> suspect -> offline`; `draining` prevents new
placement while existing work may finish. A worker should eventually maintain
an outbound authenticated connection to the gateway so private machines do not
need new public inbound ports.

The gateway must not declare a durable task failed solely because a node misses
heartbeats. On reconnect the node reports its active workspaces/tasks and the
control plane reconciles routing and terminal task state.

## Transport boundary

`NodeTransport` carries tool calls between the gateway and a node runtime. The
first remote implementation can use a persistent authenticated HTTP/WebSocket
channel, but the domain contract does not embed that choice. Transport must
support request IDs, protocol negotiation, bounded responses, cancellation,
stream/notification delivery, reconnect, and backpressure.

The gateway owns OAuth toward the AI host. Node-to-gateway authentication is a
separate trust boundary and should use per-node credentials with rotation and
revocation rather than sharing the user's MCP owner password.

## State placement

Control-plane state:

- node identity/health/capability snapshots
- global workspace -> node/local-workspace routes
- task -> node/workspace/local-task routes
- conversation placement/bindings
- future scheduling metadata

Node-local state:

- source files and worktrees
- process sessions and PIDs
- durable runner/systemd state and full logs
- credentials and local environment
- Serena/LSP backend state
- observed architecture model
- local-agent provider sessions

The current SQLite store remains appropriate for a single-user control plane.
Persistence is behind interfaces so a future PostgreSQL/replicated control
plane does not require rewriting workspace semantics.

## Normify / architecture governance

`.devspace-architecture.json` remains project intent and can be synchronized by
Git. `.devspace/architecture/*` remains observed workspace state. Cross-node
comparison must include repository revision and dirty fingerprint. Synrex
must never merge observations from different revisions into one graph merely
because their repository name matches.

## Upgrade path

1. **Foundation (implemented):** stable node identity, protocol/capability
   model, workspace/task directories, routing abstraction, standalone
   compatibility.
2. **Two-node transport (implemented baseline):** outbound worker long-poll
   connection, bootstrap join token plus per-node credentials, gateway node
   registration/heartbeat, explicit node selection at `open_workspace`, sticky
   global workspace/task identity, and reconnect with bounded exponential
   backoff. Durable task execution remains node-local across gateway loss.
3. **Operations:** node CLI/status UI, drain/offline controls, diagnostics,
   upgrade/version compatibility checks, metrics and broader failure injection
   tests. CLI list/drain/undrain is already present; UI remains future work.
4. **Capability placement:** optional resource requirements and deterministic
   eligibility/ranking. Stateful workspaces remain sticky.
5. **Optional migration/data plane:** explicit Git/checkpoint/CAS-assisted
   workspace transfer. No transparent live migration unless a demonstrated use
   case justifies its complexity.
6. **Optional HA:** only if a real need appears, replace the control-plane store
   and add replicated leadership. Do not introduce consensus systems for the
   current personal two-node deployment.

## Publication/evaluation contract

The public project should be evaluated on measurable system properties rather
than broad distributed-systems claims: schema growth as nodes increase,
workspace misrouting rate, reconnect/reconciliation correctness, durable-task
survival across gateway/network failure, added tool-call latency, context/token
overhead, and isolation of LSP/architecture observations across nodes and Git
revisions.
