import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("deploy/observability/archive-indexer.mjs");

test("archive indexer retains safe Core diagnostic JSONL without OTLP collector", t => {
  const root=mkdtempSync(path.join(os.tmpdir(),"synrex-history-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(path.join(root,"diagnostics"),{recursive:true});
  const ts=new Date().toISOString();
  writeFileSync(path.join(root,"diagnostics","recent.jsonl"),[
    JSON.stringify({ts,event:"mcp_received",requestId:"req_1",inputBytes:123,secret:"must-not-survive"}),
    JSON.stringify({ts,event:"mcp_finished",requestId:"req_1",status:200,outputBytes:456,durationMs:12}),
    JSON.stringify({ts,event:"not_allowlisted",requestId:"req_2",payload:"private"}),
    "",
  ].join("\n"));
  const env={...process.env,SYNREX_STATE_DIR:root};
  const scan=spawnSync(process.execPath,[script,"scan"],{env,encoding:"utf8"});
  assert.equal(scan.status,0,scan.stderr);
  const counts=JSON.parse(scan.stdout);
  assert.equal(counts.diagnostics,2);
  const search=spawnSync(process.execPath,[script,"search","all",
    new Date(Date.now()-60_000).toISOString(),new Date(Date.now()+60_000).toISOString()],{env,encoding:"utf8"});
  assert.equal(search.status,0,search.stderr);
  const result=JSON.parse(search.stdout);
  assert.equal(result.events.length,2);
  assert.deepEqual(result.events.map(x=>x.event).sort(),["mcp_finished","mcp_received"]);
  assert.doesNotMatch(JSON.stringify(result),/must-not-survive|private|secret/);
  const again=spawnSync(process.execPath,[script,"scan"],{env,encoding:"utf8"});
  assert.equal(again.status,0,again.stderr);
  assert.equal(JSON.parse(again.stdout).diagnostics,0,"checkpoint must prevent duplicate ingestion");
});
