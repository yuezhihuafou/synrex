#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, readSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// The Collector's JSONL file exporter is short lived. This append-only,
// idempotent metadata index retains accepted events and native spans for 7d.
// It never records chat bodies, raw command strings, OAuth secrets or URLs.
const root = process.env.SYNREX_STATE_DIR;
if (!root || !path.isAbsolute(root)) throw Error("Missing SYNREX_STATE_DIR");
const dir = path.join(root, "observability"), data = path.join(dir, "data");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dir, "history.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1500;
  CREATE TABLE IF NOT EXISTS checkpoints (source TEXT PRIMARY KEY, offset INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    source TEXT NOT NULL, byte_offset INTEGER NOT NULL, ordinal INTEGER NOT NULL,
    ts TEXT NOT NULL, event TEXT NOT NULL, request_id TEXT, trace_id TEXT, node_request_id TEXT,
    node_id TEXT, tool TEXT, data TEXT NOT NULL,
    PRIMARY KEY(source,byte_offset,ordinal));
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS events_request ON events(request_id,ts);
  CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id,ts);
  CREATE INDEX IF NOT EXISTS events_node_request ON events(node_request_id,ts);
  CREATE TABLE IF NOT EXISTS spans (
    source TEXT NOT NULL, byte_offset INTEGER NOT NULL, ordinal INTEGER NOT NULL,
    ts TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT,
    name TEXT NOT NULL, duration_ms REAL NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(source,byte_offset,ordinal));
  CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id,ts);
  CREATE TABLE IF NOT EXISTS metrics (
    minute TEXT NOT NULL, name TEXT NOT NULL, node TEXT NOT NULL, dimension TEXT NOT NULL,
    value REAL NOT NULL, PRIMARY KEY(minute,name,node,dimension));
  CREATE INDEX IF NOT EXISTS metrics_minute ON metrics(minute);
  `);
const allowedEvents = new Set([
  "stage_started","stage_finished","mcp_received","mcp_body_ready","mcp_handler_returned",
  "mcp_headers_sent","mcp_finished","mcp_failed","mcp_closed_early","mcp_stream_closed",
  "request_stalled","tool_execution_started","tool_execution_stalled","tool_execution_finished",
  "node_queued","node_delivered","node_completed","node_peer_received","node_peer_started",
  "node_peer_finished","node_peer_acknowledged","node_transport","node_request_timeout",
  "node_late_completion","task_created","task_runner_started","task_spawned","task_first_output",
  "task_finished","task_notification","mailbox_registered","mailbox_delivered","mailbox_acknowledged",
  "mailbox_error","learning_error","conversation_labeled","runtime_sampled","runtime_started",
  "runtime_stopping","network_sampled","collector_sampled","tunnel_registered","tunnel_disconnected",
  "tunnel_retry","tunnel_auth_failed","origin_unavailable","service_started","service_stopped",
]);
const eventKeys = ["ts","event","requestId","traceId","otelTraceId","otelSpanId","otelParentSpanId",
  "nodeRequestId","callId","taskId","runId","nodeId","bootId","revision","workspaceId",
  "tool","method","stage","durationMs","elapsedMs","queuedMs","status","outcome","errorCategory",
  "inputBytes","outputBytes","rssBytes","heapUsedBytes","activeToolCount","eventLoopLagMs",
  "eventLoopP95Ms","eventLoopUtilizationPermille","gcCount","gcDurationMs",
  "otelSpanPending","otelSpanDropped",
  "tcpConnections","tcpRttP50Ms","tcpRttP95Ms","tcpRetransSockets","tcpRetransSegmentsTotal",
  "collectorRefusedLogRecords","collectorRefusedMetricPoints","collectorExporterFailed","tunnelUnit"];
const obj = x => x && typeof x === "object" && !Array.isArray(x) ? x : {};
const list = x => Array.isArray(x) ? x : [];
function value(x) {const a=obj(x);return a.stringValue ?? a.intValue ?? a.doubleValue ?? a.boolValue;}
function attrs(x) {return Object.fromEntries(list(x).flatMap(y=>{
  const a=obj(y);return typeof a.key === "string" && a.key.length<80 ? [[a.key,value(a.value)]]:[];
}));}
function date(x) {return typeof x==="string" && /^\d{4}-\d{2}-\d{2}T/.test(x) && Number.isFinite(Date.parse(x)) ? x : undefined;}
function timestamp(ns) {try{return new Date(Number(BigInt(ns)/1_000_000n)).toISOString();}catch{return undefined;}}
const insertEvent=db.prepare(`INSERT OR IGNORE INTO events
  (source,byte_offset,ordinal,ts,event,request_id,trace_id,node_request_id,node_id,tool,data)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const insertSpan=db.prepare(`INSERT OR IGNORE INTO spans
  (source,byte_offset,ordinal,ts,trace_id,span_id,parent_id,name,duration_ms,data)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
const insertMetric=db.prepare(`INSERT OR IGNORE INTO metrics(minute,name,node,dimension,value) VALUES(?,?,?,?,?)`);
const saveOffset=db.prepare("INSERT INTO checkpoints(source,offset) VALUES(?,?) ON CONFLICT(source) DO UPDATE SET offset=excluded.offset");
const getOffset=db.prepare("SELECT offset FROM checkpoints WHERE source=?");
function persist(document, kind, source, offset) {
  let ordinal=0;
  if (kind==="logs") for(const resource of list(document.resourceLogs)){
    const environment=attrs(obj(resource.resource).attributes);
    for(const scope of list(resource.scopeLogs)) for(const record of list(scope.logRecords)){
      const fields=attrs(record.attributes);
      const body=value(record.body);
      if(typeof body==="string" && body.startsWith("{") && body.length<4096){
        try{Object.assign(fields,obj(JSON.parse(body)));}catch{}
      }
      if (!allowedEvents.has(fields.event))continue;
      const ts=date(fields.ts)??timestamp(record.timeUnixNano);
      if (!ts)continue;
      const clean=Object.fromEntries(eventKeys.filter(k => fields[k]!==undefined && (
        typeof fields[k]==="number" && Number.isFinite(fields[k]) ||
        typeof fields[k]==="string" && fields[k].length<150)).map(k=>[k,fields[k]]));
      clean.ts=ts;clean.nodeId=typeof fields.nodeId==="string"?fields.nodeId:environment["synrex.node.id"];
      insertEvent.run(source,offset,ordinal++,ts,fields.event,clean.requestId??null,
        clean.otelTraceId??clean.traceId??null,clean.nodeRequestId??null,clean.nodeId??null,
        clean.tool??null,JSON.stringify(clean));
    }
  }
  if (kind==="traces") for(const resource of list(document.resourceSpans))
    for(const scope of list(resource.scopeSpans)) for(const span of list(scope.spans)){
      if(!/^[0-9a-f]{32}$/.test(span.traceId??"") || !/^[0-9a-f]{16}$/.test(span.spanId??""))continue;
      const ts=timestamp(span.startTimeUnixNano);if(!ts)continue;
      const start=Number(BigInt(span.startTimeUnixNano)/1_000_000n);
      const end=Number(BigInt(span.endTimeUnixNano)/1_000_000n);
      const duration=Math.max(0,end-start);
      const fields=attrs(span.attributes);
      const entry={ts,traceId:span.traceId,spanId:span.spanId,
        parentSpanId:span.parentSpanId??undefined,name:String(span.name??"unknown").slice(0,80),
        durationMs:duration,status:span.status?.code===2?"error":"ok",
        requestId:typeof fields["synrex.request_id"]==="string"?fields["synrex.request_id"]:undefined};
      insertSpan.run(source,offset,ordinal++,ts,span.traceId,span.spanId,span.parentSpanId??null,
        entry.name,duration,JSON.stringify(entry));
    }
  if(kind==="metrics")for(const resource of list(document.resourceMetrics)){
    const common=attrs(obj(resource.resource).attributes),node=String(common["synrex.node.id"]??"local").slice(0,32);
    for(const scope of list(resource.scopeMetrics))for(const metric of list(scope.metrics)){
      if(typeof metric.name!=="string"||!(/^(system|process)\./.test(metric.name)))continue;
      const datapoints=list(obj(metric.gauge).dataPoints).concat(list(obj(metric.sum).dataPoints));
      for(const point of datapoints){
        const ts=timestamp(point.timeUnixNano);if(!ts)continue;
        const num=Number(point.asDouble??point.asInt);
        if(!Number.isFinite(num))continue;
        const minute=ts.slice(0,16);
        const dim=attrs(point.attributes),pid=common["process.pid"];
        // A small bounded dimensional projection rather than exporting every
        // device/mount/PID label: keep the long history sustainably.
        const dimension=String(dim.state??dim.direction??dim.device??(pid?"pid":"all")).slice(0,30);
        insertMetric.run(minute,metric.name,node,dimension,num);
      }
    }
  }
}
function scan(kind) {
  if(!existsSync(data))return 0;
  let count=0;
  const files=readdirSync(data).filter(n=>n.startsWith(kind+".otlp") && n.endsWith(".json"))
    .map(n=>path.join(data,n)).sort((a,b)=>statSync(a).mtimeMs-statSync(b).mtimeMs);
  for(const file of files){
    const stats=statSync(file),source=`${stats.dev}:${stats.ino}`;
    let at=Number(getOffset.get(source)?.offset??0);
    if(at>stats.size)at=0;
    const fd=openSync(file,"r"),chunk=Buffer.alloc(128*1024);
    let cursor=at, carry=Buffer.alloc(0), lineStart=at;
    try {
      db.exec("BEGIN");
      while(cursor<stats.size){
        const size=readSync(fd,chunk,0,Math.min(chunk.length,stats.size-cursor),cursor);
        if(size<=0)break;
        const buf=Buffer.concat([carry,chunk.subarray(0,size)]);let begin=0;
        while(true){
          const end=buf.indexOf(10,begin);if(end<0)break;
          const line=buf.subarray(begin,end);
          if(line.length && line.length<=2*1024*1024) {
            try{persist(JSON.parse(line.toString("utf8")),kind,source,lineStart);count++;}catch{}
          }
          lineStart+=end+1-begin;begin=end+1;
        }
        carry=buf.subarray(begin);
        if(carry.length>2*1024*1024){carry=Buffer.alloc(0);lineStart=cursor+size;}
        cursor+=size;
      }
      saveOffset.run(source,lineStart);
      db.exec("COMMIT");
    }catch(e){db.exec("ROLLBACK");throw e;}
    finally{closeSync(fd);}
  }
  return count;
}
function prune(){
  const cutoff=new Date(Date.now()-7*24*60*60*1000).toISOString();
  db.prepare("DELETE FROM events WHERE ts<?").run(cutoff);
  db.prepare("DELETE FROM spans WHERE ts<?").run(cutoff);
  db.prepare("DELETE FROM metrics WHERE minute<?").run(cutoff.slice(0,16));
}
function query(args) {
  const [mode,term="",start="",end=""]=args;
  if(mode==="trace" && /^[a-zA-Z0-9_-]{1,110}$/.test(term)){
    const events=db.prepare(`SELECT data FROM events WHERE request_id=? OR trace_id=? OR node_request_id=? ORDER BY ts LIMIT 1500`)
      .all(term,term,term).map(r=>JSON.parse(r.data));
    const traces=[...new Set(events.map(x=>x.otelTraceId).filter(Boolean)
      .concat(/^[0-9a-f]{32}$/.test(term)?[term]:[]))].slice(0,8);
    const spans=traces.flatMap(id=>db.prepare("SELECT data FROM spans WHERE trace_id=? ORDER BY ts LIMIT 1000")
      .all(id).map(r=>JSON.parse(r.data))).slice(0,1500);
    console.log(JSON.stringify({events,spans}));
  }else if(mode==="search"){
    const after=date(start)||new Date(Date.now()-7*86400000).toISOString();
    const before=date(end)||new Date().toISOString();
    const event=allowedEvents.has(term)?term:null;
    const rows=event
      ?db.prepare("SELECT data FROM events WHERE ts BETWEEN ? AND ? AND event=? ORDER BY ts DESC LIMIT 500").all(after,before,event)
      :db.prepare("SELECT data FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 500").all(after,before);
    console.log(JSON.stringify({events:rows.map(r=>JSON.parse(r.data)),truncated:rows.length===500}));
  }else if(mode==="stats"){
    console.log(JSON.stringify({events:db.prepare("SELECT count(*) n,min(ts) first,max(ts) last FROM events").get(),
      spans:db.prepare("SELECT count(*) n FROM spans").get(),
      metrics:db.prepare("SELECT count(*) n FROM metrics").get()}));
  }else {throw Error("Invalid index query");}
}
if(process.argv[2]==="serve"){
  function update(){try{for(const k of ["logs","traces","metrics"])scan(k);prune();}catch(e){console.error("Index scan failed",e?.name??"unknown");}}
  update();setInterval(update,15000);
}else if(process.argv[2]==="scan") {
  const counts=Object.fromEntries(["logs","traces","metrics"].map(k=>[k,scan(k)]));prune();
  console.log(JSON.stringify(counts));
}else query(process.argv.slice(2));
