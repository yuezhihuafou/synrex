import { Result, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import { deleteWorkspaceReviewRefs } from "./review-checkpoints.js";
import {
  closeWorkspaceStoreResult,
  createWorkspaceStoreResult,
  type WorkspaceStoreError,
} from "./workspace-store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceMetadataCleanupResult {
  sessions: number;
  conversationBindings: number;
  reviewRefWorkspaces: number;
}

export async function pruneStaleWorkspaceMetadata(
  config: ServerConfig,
  now = new Date(),
): Promise<BetterResult<WorkspaceMetadataCleanupResult, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  let pruned!: ReturnType<typeof opened.value.pruneMetadata>;
  let closed!: ReturnType<typeof closeWorkspaceStoreResult>;
  try {
    const before = new Date(now.getTime() - config.metadataRetentionDays * DAY_MS);
    pruned = opened.value.pruneMetadata(before);
  } finally {
    closed = closeWorkspaceStoreResult(opened.value);
  }
  if (pruned.isErr()) return pruned;
  if (closed.isErr()) return closed;

  await Promise.all(pruned.value.sessions.map((session) => (
    deleteWorkspaceReviewRefs(session.sourceRoot ?? session.root, session.id)
  )));
  return Result.ok({
    sessions: pruned.value.sessions.length,
    conversationBindings: pruned.value.conversationBindings,
    reviewRefWorkspaces: pruned.value.sessions.length,
  });
}
