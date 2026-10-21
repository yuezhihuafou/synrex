import { createHash } from "node:crypto";

function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function conversationScopeIdFromRequestMeta(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

/** Stable, non-reversible join key for tool diagnostics; never log raw host session IDs. */
export function conversationTraceIdFromRequestMeta(meta: unknown): string | undefined {
  const scope = conversationScopeIdFromRequestMeta(meta);
  return scope
    ? `conv_${createHash("sha256").update(scope).digest("hex").slice(0, 32)}`
    : undefined;
}

/** A title is not generally present in ChatGPT MCP metadata. Only use a title
 * supplied explicitly by a host extension or the open_workspace caller.
 */
export function safeConversationTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title.length > 0 && title.length <= 120 && !/[\x00-\x1f\x7f]/.test(title)
    ? title : undefined;
}

export function conversationTitleFromRequestMeta(meta: unknown): string | undefined {
  return safeConversationTitle(metadataString(meta, "openai/conversation_title"));
}
