# Bounded `show_changes` responses (2026-11-19)

## Problem and observed evidence

The ChatGPT host showed “消息传输超时。请重试。” after a long-running coding turn that included a large `show_changes` card. The host-side timeout cause is not observable in Synrex logs and must not be asserted as proven. The server did, however, send the entire binary Git diff as `_meta.card.payload.patch` regardless of size. `readReviewBetween` allows up to 50 MiB per Git diff. On the robotics workspace, stored review checkpoints included patches of 1.67–1.83 MiB for approximately 300-file changes. The model-visible text was only a short summary; the App metadata was not bounded.

## Decision

Keep the durable Git review checkpoint and complete `reviewRef` as authority. Limit the in-band App patch to 96 KiB; for larger reviews, send the file statistics and an omission marker instead. Limit the in-band file list to 200 entries, preserving the total count, and truncate excessively long display paths. The MCP result continues to return `workspaceId`, `reviewRef`, and the human-readable summary. The App shows a metadata-only file list for oversized reviews and tells the user how to retrieve the complete patch on the owning machine with `synrex review <reviewRef>`. The same limit applies to reopening historical reviews.

This changes only the host-facing preview, not source content, Git snapshot semantics, review receipts, or the full on-disk patch. Small reviews retain existing inline diff rendering and result schemas.

## Verification and boundaries

Tests cover small diff fidelity, Unicode byte accounting, 163-file metadata, 400-file caps, and the actual MCP tool call plus historical review reload. Build/typecheck and real ingress smoke are separate release gates. This reduces a demonstrated Synrex-side transport-amplification risk; it does **not** claim to override the ChatGPT host's conversation-wide response timeout, terminate long GPT thinking, or guarantee a particular browser connection.

Rollback: restore the previous pinned immutable release; no state migration or OAuth identity change is required.
