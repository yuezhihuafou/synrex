import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

// Exclusively called from the 15-second snapshot sidecar, never by MCP/Console HTTP.
// Keep a single small JSON ledger in the existing private observability directory.
type Bucket = { input: number; output: number; calls: number; inputSamples: number; outputSamples: number;
  runtimeOutputTokens?: number; runtimeDurationMs?: number; runtimeSamples?: number };
type Peak = { at: string; tokens: number; tokensPerSecond: number };
type CallPeak = { at: string; tokens: number };
type Cursor = { offset: number; lastSeenAt: string };
type PendingRun = { outputTokens?: number; durationMs?: number; finishedAt?: string; sampledAt?: string };
type RuntimeTotal = { outputTokens: number; durationMs: number; samples: number; observedFrom: string | null };
export interface TokenHistory {
  schemaVersion: 1; encoding: "o200k_base"; startedAt: string; observedFrom?: string; updatedAt: string;
  totals: Bucket; peakMinute: Peak | null; peakOutputCall: CallPeak | null;
  minute: Record<string, Bucket>; hour: Record<string, Bucket>; day: Record<string, Bucket>;
  cursors: Record<string, Cursor>; gaps: number;
  /** Added without resetting existing persisted totals or their cursors. */
  runtime?: RuntimeTotal;
  pendingRuns?: Record<string, PendingRun>;
  completedRuns?: Record<string,string>;
}
const empty = (): Bucket => ({ input: 0, output: 0, calls: 0, inputSamples: 0, outputSamples: 0 });
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const fileName = "token-history.json";

function load(file: string, now: Date): TokenHistory {
  if (existsSync(file)) {
    // Corruption must not be silently converted into a false zero lifetime history.
    const saved = JSON.parse(readFileSync(file, "utf8")) as TokenHistory;
    if (saved.schemaVersion !== 1 || saved.encoding !== "o200k_base" ||
        !saved.totals || !saved.cursors || !saved.minute || !saved.hour || !saved.day ||
        !isCount(saved.totals.input) || !isCount(saved.totals.output) || !isCount(saved.gaps)) {
      throw Error("Unsupported or corrupt Token history; retained for inspection");
    }
    return saved;
  }
  return { schemaVersion: 1, encoding: "o200k_base", startedAt: now.toISOString(),
    updatedAt: now.toISOString(), totals: empty(), peakMinute: null, peakOutputCall: null,
    minute: {}, hour: {}, day: {}, cursors: {}, gaps: 0 };
}

function applyEvent(history: TokenHistory, entry: DiagnosticEntry): void {
  const time=Date.parse(entry.ts);
  if (!Number.isFinite(time)) return;
  const iso=new Date(time).toISOString();
  const minute=iso.slice(0,16)+":00.000Z";
  const hour=iso.slice(0,13)+":00:00.000Z";
  const day=iso.slice(0,10);
  const isInput=(entry.event === "tool_tokens_measured" ||
    (entry.event === "mcp_body_ready" && entry.rpcMethod === "tools/call")) && isCount(entry.inputTokens);
  const isOutput=(entry.event === "tool_tokens_measured" || entry.event === "mcp_finished") && isCount(entry.outputTokens);
  const isCall=entry.event === "tool_execution_started";
  const isFinish=entry.event === "mcp_finished" && typeof entry.durationMs === "number"
    && Number.isFinite(entry.durationMs) && entry.durationMs>0;
  if (!isInput && !isOutput && !isCall && !isFinish) return;
  if(!history.observedFrom || iso<history.observedFrom)history.observedFrom=iso;
  const minuteBucket=history.minute[minute]??(history.minute[minute]=empty());
  const hourBucket=history.hour[hour]??(history.hour[hour]=empty());
  const dayBucket=history.day[day]??(history.day[day]=empty());
  const buckets=[history.totals,minuteBucket,hourBucket,dayBucket];
  for (const b of buckets) {
    if (isInput) { b.input+=entry.inputTokens!; b.inputSamples++; }
    if (isOutput) { b.output+=entry.outputTokens!; b.outputSamples++; }
    if (isCall) b.calls++;
  }
  if (isOutput) {
    const tokens=entry.outputTokens!;
    const current=history.minute[minute]!;
    if (!history.peakMinute || current.output>history.peakMinute.tokens) {
      history.peakMinute={at:minute,tokens:current.output,tokensPerSecond:Math.round(current.output/60*10)/10};
    }
    if (!history.peakOutputCall || tokens>history.peakOutputCall.tokens) {
      history.peakOutputCall={at:iso,tokens};
    }
  }
  // Pair asynchronous Token-worker results with the original completed request.
  // Never persist tool text or invent a duration for missing/unfinished calls.
  const requestId=entry.requestId??entry.traceId;
  if (requestId && (isOutput||isFinish) && !history.completedRuns?.[requestId]) {
    history.runtime??={outputTokens:0,durationMs:0,samples:0,observedFrom:null};
    history.pendingRuns??={};
    const pending=history.pendingRuns[requestId]??(history.pendingRuns[requestId]={});
    if (isOutput && pending.outputTokens===undefined) {
      pending.outputTokens=entry.outputTokens;
      pending.sampledAt=iso;
    }
    if (isFinish && pending.durationMs===undefined) {
      pending.durationMs=entry.durationMs;
      pending.finishedAt=iso;
    }
    if (isCount(pending.outputTokens) && typeof pending.durationMs==="number" && pending.durationMs>0) {
      // Charge a complete call once, at its finish timestamp, even when its
      // output measurement arrives in a later snapshot/timer cycle.
      const completedAt=pending.finishedAt??iso;
      const completedMinute=completedAt.slice(0,16)+":00.000Z";
      const completedHour=completedAt.slice(0,13)+":00:00.000Z";
      const completedDay=completedAt.slice(0,10);
      const matchedBuckets=[history.totals,
        history.minute[completedMinute]??(history.minute[completedMinute]=empty()),
        history.hour[completedHour]??(history.hour[completedHour]=empty()),
        history.day[completedDay]??(history.day[completedDay]=empty())];
      for (const b of matchedBuckets) {
        b.runtimeOutputTokens=(b.runtimeOutputTokens??0)+pending.outputTokens;
        b.runtimeDurationMs=(b.runtimeDurationMs??0)+pending.durationMs;
        b.runtimeSamples=(b.runtimeSamples??0)+1;
      }
      history.runtime.outputTokens+=pending.outputTokens;
      history.runtime.durationMs+=pending.durationMs;
      history.runtime.samples++;
      if (!history.runtime.observedFrom || completedAt<history.runtime.observedFrom) history.runtime.observedFrom=completedAt;
      delete history.pendingRuns[requestId];
      history.completedRuns??={};
      history.completedRuns[requestId]=completedAt;
    }
  }
}

function prune(history: TokenHistory, now: Date): void {
  for (const [unit, entries, keep] of [
    ["minute",history.minute,24*3600_000],
    ["hour",history.hour,30*86400_000],
    ["day",history.day,365*86400_000],
  ] as const) {
    for (const key of Object.keys(entries)) {
      const at=Date.parse(unit === "day" ? `${key}T00:00:00Z` : key);
      if (!Number.isFinite(at) || at < now.getTime()-keep || at>now.getTime()+60_000) delete entries[key];
    }
  }
  // A cursor is keyed by device/inode, so a normal log rotation does not replay events.
  // Preserve recent inodes across subsequent runs and bound historical cursor entries.
  for (const [inode,cursor] of Object.entries(history.cursors)) {
    if (Date.parse(cursor.lastSeenAt) < now.getTime()-2*86400_000) delete history.cursors[inode];
  }
  const pending=history.pendingRuns??{};
  for (const [id,run] of Object.entries(pending)) {
    const at=Date.parse(run.finishedAt??run.sampledAt??"");
    if (!Number.isFinite(at)||at<now.getTime()-86400_000) delete pending[id];
  }
  // Bound sidecar memory in case repeated unfinished requests accumulate.
  const ids=Object.keys(pending);
  if(ids.length>2048) {
    ids.sort((a,b)=>Date.parse(pending[a]?.finishedAt??pending[a]?.sampledAt??"")-
      Date.parse(pending[b]?.finishedAt??pending[b]?.sampledAt??""));
    for(const id of ids.slice(0,ids.length-2048))delete pending[id];
  }
  const completed=history.completedRuns??{};
  for(const [id,ts] of Object.entries(completed)) {
    if(Date.parse(ts)<now.getTime()-86400_000)delete completed[id];
  }
  const completedIds=Object.keys(completed);
  if(completedIds.length>2048) {
    completedIds.sort((a,b)=>Date.parse(completed[a]!)-Date.parse(completed[b]!));
    for(const id of completedIds.slice(0,completedIds.length-2048))delete completed[id];
  }
}

function average(tokens:number,durationMs:number):number|null {
  return durationMs>0?Math.round(tokens*10000/durationMs)/10:null;
}

/** Tail only appended complete lines. State/cursors and counters commit atomically. */
export function updateTokenHistory(stateDir: string, now=new Date()): TokenHistory {
  const dir=path.join(stateDir,"observability");
  const target=path.join(dir,fileName);
  const state=load(target,now);
  const logs=path.join(stateDir,"diagnostics","recent.jsonl");
  const names=[logs+".1",logs];
  const live=new Set<string>();
  for (const file of names) {
    if (!existsSync(file)) continue;
    const stat=statSync(file);
    const inode=`${stat.dev}:${stat.ino}`;
    live.add(inode);
    const previous=state.cursors[inode];
    const offset=previous && previous.offset<=stat.size?previous.offset:0;
    if (previous && previous.offset>stat.size) state.gaps++;
    const size=Math.max(0,stat.size-offset);
    // Each diagnostic file is 8 MiB at most, but don't permit an unbounded read.
    if(size>9*1024*1024) { state.gaps++; continue; }
    const fd=openSync(file,"r");
    let buffer:Buffer;
    try {
      buffer=Buffer.alloc(size);
      let pos=0;
      while(pos<size){
        const n=readSync(fd,buffer,pos,size-pos,offset+pos);
        if(n===0)break;
        pos+=n;
      }
      buffer=buffer.subarray(0,pos);
    } finally {closeSync(fd);}
    const lastNewline=buffer.lastIndexOf(10);
    const consumed=lastNewline<0?0:lastNewline+1;
    if(consumed) {
      for(const line of buffer.subarray(0,consumed).toString("utf8").split("\n")) {
        if(!line)continue;
        try {applyEvent(state,JSON.parse(line) as DiagnosticEntry);} catch {state.gaps++;}
      }
    }
    state.cursors[inode]={offset:offset+consumed,lastSeenAt:now.toISOString()};
  }
  // A previously seen active inode disappearing from both rotating logs means
  // an interval was lost; never misrepresent the aggregate as complete.
  for(const [inode,cursor] of Object.entries(state.cursors)) {
    if (!live.has(inode) && Date.parse(cursor.lastSeenAt)===Date.parse(state.updatedAt)) state.gaps++;
  }
  prune(state,now);
  state.updatedAt=now.toISOString();
  mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=target+`.${process.pid}.tmp`;
  writeFileSync(tmp,JSON.stringify(state),{mode:0o600});
  renameSync(tmp,target);
  return state;
}

/** Copy only public aggregate fields into the cached authenticated Console snapshot. */
export function tokenHistorySummary(s: TokenHistory) {
  const series=(o: Record<string,Bucket>)=>Object.entries(o).sort(([a],[b])=>a.localeCompare(b))
    .map(([at,b])=>({at,inputTokens:b.input,outputTokens:b.output,calls:b.calls,
      measuredInputs:b.inputSamples,measuredOutputs:b.outputSamples,
      runtimeMatchedTokens:b.runtimeOutputTokens??0,runtimeDurationMs:b.runtimeDurationMs??0,
      runtimeSamples:b.runtimeSamples??0,
      runtimeAverageTokensPerSecond:average(b.runtimeOutputTokens??0,b.runtimeDurationMs??0)}));
  const total=s.runtime;
  return {startedAt:s.startedAt,observedFrom:s.observedFrom??null,updatedAt:s.updatedAt,coverageGaps:s.gaps,
    totals:{inputTokens:s.totals.input,outputTokens:s.totals.output,calls:s.totals.calls,
      measuredInputs:s.totals.inputSamples,measuredOutputs:s.totals.outputSamples},
    peakMinute:s.peakMinute,peakOutputCall:s.peakOutputCall,
    runtime:{averageTokensPerSecond:average(total?.outputTokens??0,total?.durationMs??0),
      matchedOutputTokens:total?.outputTokens??0,matchedDurationMs:total?.durationMs??0,
      measuredCalls:total?.samples??0,observedFrom:total?.observedFrom??null},
    minute:series(s.minute),hour:series(s.hour),day:series(s.day)};
}
