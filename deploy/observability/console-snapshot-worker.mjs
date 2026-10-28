#!/usr/bin/env node
// Out-of-process snapshot. Live MCP only serves the last atomic JSON file.
import { writeFileSync,renameSync,mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=process.env.SYNREX_STATE_DIR;
const release=process.env.SYNREX_RELEASE_DIR;
if(!root||!release||!path.isAbsolute(root)||!path.isAbsolute(release))throw Error("Missing paths");
const {readConsoleSnapshot}=await import(pathToFileURL(path.join(release,"dist/console-snapshot.js")).href);
const {updateTokenHistory,tokenHistorySummary}=await import(
  pathToFileURL(path.join(release,"dist/console-token-history.js")).href);
const started=Date.now();
const snapshot=readConsoleSnapshot(root,path.basename(release));
// Persistent counters run only in this separate systemd timer process.
// A damaged/missing history must not block other Console data.
let persistent;
try {persistent=tokenHistorySummary(updateTokenHistory(root));}
catch(error){
  console.warn("SYNREX_TOKEN_HISTORY_UNAVAILABLE",error instanceof Error?error.message:String(error));
}
snapshot.diagnostics.observability.tokens.history=persistent??null;
const dir=path.join(root,"observability");mkdirSync(dir,{recursive:true});
const target=path.join(dir,"console-snapshot.json");
writeFileSync(target+".tmp",JSON.stringify({...snapshot,
  snapshotBuildMs:Date.now()-started}),{mode:0o600});
renameSync(target+".tmp",target);
console.log(JSON.stringify({generatedAt:snapshot.generatedAt,buildMs:Date.now()-started}));
