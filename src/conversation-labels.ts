import path from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { safeConversationTitle } from "./request-meta.js";

// Owner-supplied labels: ChatGPT does not reliably provide its conversation
// title in MCP metadata. An explicit mapping must never be mistaken for an
// automatically inferred host session association.
const SAFE_REQUEST = /^[a-zA-Z0-9_-]{1,110}$/;
const SAFE_CONVERSATION = /^conv_[a-f0-9]{32}$/;

export interface ConversationLabel {
  requestId: string;
  conversationTitle: string;
  conversationId?: string;
  source: "owner" | "host";
  updatedAt: string;
}

function withDb<T>(stateDir: string, action: (db: Database.Database) => T): T {
  const dir = path.join(stateDir, "observability");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file=path.join(dir,"conversation-labels.sqlite");
  const db = new Database(file, { timeout: 250 });
  try {
    chmodSync(file,0o600);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_labels (
      request_id TEXT PRIMARY KEY,
      conversation_title TEXT NOT NULL,
      conversation_id TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    return action(db);
  } finally { db.close(); }
}

export function assignConversationLabel(
  stateDir: string, requestId: unknown, title: unknown, conversationId?: unknown,
): ConversationLabel {
  if (typeof requestId !== "string" || !SAFE_REQUEST.test(requestId)) throw Error("Invalid request ID");
  const conversationTitle = safeConversationTitle(title);
  if (!conversationTitle) throw Error("Invalid conversation title");
  const id = typeof conversationId === "string" && SAFE_CONVERSATION.test(conversationId)
    ? conversationId : undefined;
  const result: ConversationLabel = {
    requestId, conversationTitle, ...(id ? { conversationId: id } : {}),
    source: "owner", updatedAt: new Date().toISOString(),
  };
  withDb(stateDir, db => db.prepare(`INSERT INTO conversation_labels
    (request_id,conversation_title,conversation_id,source,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET conversation_title=excluded.conversation_title,
    conversation_id=excluded.conversation_id,source=excluded.source,
    updated_at=excluded.updated_at`).run(
    result.requestId, result.conversationTitle, result.conversationId ?? null,
    result.source, result.updatedAt));
  return result;
}

export function readConversationLabels(stateDir: string, requestIds: string[]): ConversationLabel[] {
  const safe = [...new Set(requestIds.filter(x => SAFE_REQUEST.test(x)))].slice(0, 1000);
  if (!safe.length) return [];
  return withDb(stateDir, db => {
    const statement = db.prepare("SELECT request_id,conversation_title,conversation_id,source,updated_at FROM conversation_labels WHERE request_id=?");
    return safe.flatMap(id => {
      const row = statement.get(id) as {
        request_id:string;conversation_title:string;conversation_id:string|null;
        source:"owner"|"host";updated_at:string
      } | undefined;
      return row ? [{ requestId:row.request_id, conversationTitle:row.conversation_title,
        ...(row.conversation_id ? {conversationId:row.conversation_id}:{}),
        source:row.source, updatedAt:row.updated_at }] : [];
    });
  });
}
