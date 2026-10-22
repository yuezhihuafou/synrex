import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import Database from "better-sqlite3";
import type { DiagnosticEntry } from "./diagnostic-trace.js";

export interface ArchivedSpan {
  ts: string; traceId: string; spanId: string; parentSpanId?: string;
  name: string; durationMs: number; status: string; requestId?: string;
}
export interface ArchivedTrace { events: DiagnosticEntry[]; spans: ArchivedSpan[]; remoteState?: "available" | "unavailable"; }
const exec = promisify(execFile);
const ID = /^[a-zA-Z0-9_-]{1,110}$/;
function database<T>(root: string, fallback: T, fn: (db: Database.Database) => T): T {
  const file = path.join(root, "observability", "history.sqlite");
  if (!existsSync(file)) return fallback;
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
  try { return fn(db); } finally { db.close(); }
}
function parse<T>(v: string): T { return JSON.parse(v) as T; }
function archivedTrace(root: string, id: string): ArchivedTrace {
  return database(root, { events: [], spans: [] }, db => {
    const events = (db.prepare(`SELECT data FROM events
      WHERE request_id=? OR trace_id=? OR node_request_id=? ORDER BY ts ASC LIMIT 1500`)
      .all(id,id,id) as Array<{data:string}>).map(r=>parse<DiagnosticEntry>(r.data));
    const traceIds = [...new Set([...events.map(e=>e.otelTraceId),/^[a-f0-9]{32}$/.test(id)?id:undefined]
      .filter((s):s is string=>Boolean(s)))].slice(0,8);
    const spans = traceIds.flatMap(traceId =>
      (db.prepare("SELECT data FROM spans WHERE trace_id=? ORDER BY ts ASC LIMIT 1000")
        .all(traceId) as Array<{data:string}>).map(r=>parse<ArchivedSpan>(r.data))).slice(0,1500);
    return { events, spans };
  });
}
export function readArchivedTrace(root: string, id: string): ArchivedTrace {
  if (!ID.test(id)) return { events: [], spans: [] };
  return archivedTrace(root,id);
}
export function searchArchive(root: string, filter: {start?:string; end?:string; event?:string}): DiagnosticEntry[] {
  const end=filter.end && !Number.isNaN(Date.parse(filter.end)) ? filter.end : new Date().toISOString();
  const start=filter.start && !Number.isNaN(Date.parse(filter.start)) ? filter.start
    : new Date(Date.now()-7*86400_000).toISOString();
  const event=filter.event && /^[a-z_]{3,60}$/.test(filter.event) ? filter.event : undefined;
  if(Date.parse(start)>Date.parse(end) || Date.parse(end)-Date.parse(start)>8*86400_000)return [];
  return database(root, [], db =>
    (event
      ?db.prepare("SELECT data FROM events WHERE ts BETWEEN ? AND ? AND event=? ORDER BY ts DESC LIMIT 500").all(start,end,event)
      :db.prepare("SELECT data FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500").all(start,end)
    ).map((r:any)=>parse<DiagnosticEntry>(r.data)));
}
export function historyStats(root: string): {events:number;spans:number;metrics:number;first?:string;last?:string} {
  return database(root, {events:0,spans:0,metrics:0,first:undefined,last:undefined} as
    {events:number;spans:number;metrics:number;first?:string;last?:string}, db => {
    const events=db.prepare("SELECT COUNT(*) count,MIN(ts) first,MAX(ts) last FROM events").get() as
      {count:number;first:string|null;last:string|null};
    const spans=db.prepare("SELECT COUNT(*) count FROM spans").get() as {count:number};
    const metrics=db.prepare("SELECT COUNT(*) count FROM metrics").get() as {count:number};
    return {events:events.count,spans:spans.count,metrics:metrics.count,
      first:events.first??undefined,last:events.last??undefined};
  });
}
export async function readGatewayArchivedTrace(id:string):Promise<ArchivedTrace> {
  if(!ID.test(id))return {events:[],spans:[],remoteState:"unavailable"};
  try {
    // Fixed command and allowlisted request identifier; SSH is only used for
    // peer diagnostic reads, never for arbitrary browser-supplied shell code.
    const command = "/home/swy/.nvm/versions/node/v22.22.2/bin/node --no-warnings " +
      "/home/swy/.local/share/synrex-observability/archive-indexer.mjs trace "+id;
    const {stdout}=await exec("ssh",["-o","BatchMode=yes","-o","ConnectTimeout=2","gateway",command],
      {timeout:3500,maxBuffer:1_200_000});
    const result=JSON.parse(stdout) as ArchivedTrace;
    return {events:Array.isArray(result.events)?result.events.slice(0,1500):[],
      spans:Array.isArray(result.spans)?result.spans.slice(0,1500):[],remoteState:"available"};
  } catch { return {events:[],spans:[],remoteState:"unavailable"}; }
}
export async function searchGatewayArchive(filter:{start?:string;end?:string;event?:string})
  :Promise<{events:DiagnosticEntry[];available:boolean}> {
  const start=filter.start&&/^\d{4}-\d{2}-\d{2}T[0-9:.Z-]{8,25}$/.test(filter.start)?filter.start
    :new Date(Date.now()-7*86400_000).toISOString();
  const end=filter.end&&/^\d{4}-\d{2}-\d{2}T[0-9:.Z-]{8,25}$/.test(filter.end)?filter.end
    :new Date().toISOString();
  const event=filter.event&&/^[a-z_]{3,60}$/.test(filter.event)?filter.event:"all";
  if(Date.parse(end)<Date.parse(start)||Date.parse(end)-Date.parse(start)>8*86400_000)
    return {events:[],available:false};
  try {
    // Restrict remote arguments to fixed timestamp and event alphabets.
    const command = "/home/swy/.nvm/versions/node/v22.22.2/bin/node --no-warnings " +
      "/home/swy/.local/share/synrex-observability/archive-indexer.mjs search "+
      event+" "+start+" "+end;
    const {stdout}=await exec("ssh",["-o","BatchMode=yes","-o","ConnectTimeout=2","gateway",command],
      {timeout:4000,maxBuffer:1_500_000});
    const parsed=JSON.parse(stdout) as {events:DiagnosticEntry[]};
    return {events:Array.isArray(parsed.events)?parsed.events.slice(0,500):[],available:true};
  } catch {return {events:[],available:false};}
}
