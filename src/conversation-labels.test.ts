import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { assignConversationLabel, readConversationLabels } from "./conversation-labels.js";
import { sanitizeDiagnostic, summarizeDiagnosticTrace } from "./diagnostic-trace.js";

test("explicit owner title persists by exact request without leaking to neighboring requests",t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"synrex-label-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const row=assignConversationLabel(dir,"request-a","评估全链路日志");
  assert.equal(row.source,"owner");
  assert.equal(readConversationLabels(dir,["request-a"])[0]?.conversationTitle,"评估全链路日志");
  assert.equal(statSync(path.join(dir,"observability","conversation-labels.sqlite")).mode & 0o777,0o600);
  assert.equal(readConversationLabels(dir,["request-b"]).length,0);
  assert.throws(()=>assignConversationLabel(dir,"../other","secret"));
  assert.throws(()=>assignConversationLabel(dir,"request-a","hello\npassword"));
  const labeled=sanitizeDiagnostic("conversation_labeled",{requestId:"request-a",conversationTitle:"评估全链路日志"});
  assert.equal(labeled.conversationTitle,"评估全链路日志");
  const summary=summarizeDiagnosticTrace([
    labeled,
    sanitizeDiagnostic("mcp_finished",{requestId:"request-a",status:200}),
    sanitizeDiagnostic("mcp_finished",{requestId:"request-b",status:200}),
  ]);
  assert.equal(summary.requests.find(r=>r.requestId==="request-a")?.conversationTitle,"评估全链路日志");
  assert.equal(summary.requests.find(r=>r.requestId==="request-b")?.conversationTitle,undefined);
});
