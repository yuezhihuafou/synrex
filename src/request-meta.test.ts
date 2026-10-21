import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationScopeIdFromRequestMeta,
  conversationTraceIdFromRequestMeta,
  safeConversationTitle,
  conversationTitleFromRequestMeta,
} from "./request-meta.js";

test("conversation scope resolves valid OpenAI session metadata", () => {
  for (const meta of [
    undefined,
    {},
    { "openai/session": "" },
    { "openai/session": 42 },
    { "openai/session": {} },
  ]) {
    assert.equal(conversationScopeIdFromRequestMeta(meta), undefined);
  }

  assert.equal(
    conversationScopeIdFromRequestMeta({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});

test("diagnostics correlate an opaque chat session without logging the raw identifier", () => {
  const id = conversationTraceIdFromRequestMeta({ "openai/session": "private-session-abc" });
  assert.match(id ?? "", /^conv_[a-f0-9]{32}$/);
  assert.equal(id, conversationTraceIdFromRequestMeta({ "openai/session": "private-session-abc" }));
  assert.notEqual(id, conversationTraceIdFromRequestMeta({ "openai/session": "other" }));
  assert.equal(conversationTraceIdFromRequestMeta({}), undefined);
  assert.equal(conversationTitleFromRequestMeta({ "openai/session": "only-id" }), undefined);
  assert.equal(conversationTitleFromRequestMeta({ "openai/conversation_title": "Synrex问题分析" }), "Synrex问题分析");
  assert.equal(safeConversationTitle(" manual label "), "manual label");
  assert.equal(safeConversationTitle("malicious\nlog"), undefined);
  assert.equal(safeConversationTitle("a".repeat(121)), undefined);
});
