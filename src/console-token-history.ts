import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

// Exclusively called from the 15-second snapshot sidecar, never by MCP/Console HTTP.
// Keep a single small JSON ledger in the existing private observability directory.
type Bucket = { input: number; output: number; calls: number; inputSamples: number; outputSamples: number };
type Peak = { at: string; tokens: number; tokensPerSecond: number };
type CallPeak = { at: string; tokens: number };
type Cursor = { offset: number; lastSeenAt: string };
export interface TokenHistory {
  schemaVersion: 1; encoding: "o200k_base"; startedAt: string; observedFrom?: string; updatedAt: string;
  totals: Bucket; peakMinute: Peak | null; peakOutputCall: CallPeak | null;
  minute: Record<string, Bucket>; hour: Record<string, Bucket>; day: Record<string, Bucket>;
  cursors: Record<string, Cursor>; gaps: number;
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
  if (!isInput && !isOutput && !isCall) return;
  if(!history.observedFrom || iso<history.observedFrom)history.observedFrom=iso;
  const buckets=[history.totals,
    history.minute[minute]??(history.minute[minute]=empty()),
    history.hour[hour]??(history.hour[hour]=empty()),
    history.day[day]??(history.day[day]=empty())];
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
      measuredInputs:b.inputSamples,measuredOutputs:b.outputSamples}));
  return {startedAt:s.startedAt,observedFrom:s.observedFrom??null,updatedAt:s.updatedAt,coverageGaps:s.gaps,
    totals:{inputTokens:s.totals.input,outputTokens:s.totals.output,calls:s.totals.calls,
      measuredInputs:s.totals.inputSamples,measuredOutputs:s.totals.outputSamples},
    peakMinute:s.peakMinute,peakOutputCall:s.peakOutputCall,
    minute:series(s.minute),hour:series(s.hour),day:series(s.day)};
}
