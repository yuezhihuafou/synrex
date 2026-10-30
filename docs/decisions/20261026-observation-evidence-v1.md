# 2026-10-26 — Source-independent observation evidence (v1)

## Problem

Synrex can return ordinary file images, but its old batch reader discarded
image blocks, media/ROS2 previews were not integrated into main, and no shared
representation linked an observation to its source and capture instant.
Future GUI, document, camera and simulation adapters must not each invent a
second reasoning loop or state store.

## Decision

- Keep ordinary ChatGPT as the semantic reasoner, and keep `read` backwards
  compatible. A new generic `ObservationSource` and `ObservationEvidence`
  envelope lives in `src/observation/evidence.ts`. Source kind is an open
  string; new adapters need not be named in a central robot/UI switch.
- Reuse Pi image content, bounded ffmpeg video previews, and read-only ROS2
  snapshots. Attach provenance without hiding or re-encoding image bytes as
  textual base64. A successful capture is **not** goal verification.
- Use workspace-scoped path checks and the existing execution peer; the
  coordinator forwards MCP content and existing structured metadata. No new
  public upload route, identity authority, durable task store or agent loop.
- Bound preview payloads. Preserve the original file or sensor frame identity;
  never describe pseudocolor depth as metric depth or infer an eye-in-hand
  transform from one frame.
- Do not create an additional pre-motion gate or change robot command paths.
  Physical experiment control stays in the owning robot project.

## Alternatives rejected for this increment

1. A second autonomous vision agent or mandatory external model — duplicates
   the host's reasoning, adds latency/cost and changes the product boundary.
2. Domain-specific helpers such as peg detection or PDF page checking in the
   Synrex core — would prevent generalized data-source reuse.
3. Continuous streaming plus model auto-wake by default — ordinary ChatGPT
   conversations do not currently guarantee that contract.

## Authority, rollback and verification

The user authorized P0/P1 integration and Observation abstraction in this
development task. No new production release, OAuth changes or robot actuation
are authorized by that request. Revert these source changes to remove the
candidate; the pinned service remains untouched. Focused tests must verify
real MCP image blocks, cross-node forwarding and failure semantics; runtime
deployment requires its existing independent release process.
