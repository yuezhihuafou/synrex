// Local, metadata-only ChatGPT HTTP lifecycle monitor. No prompt/response
// bodies, path, query, headers, cookies, user IDs or full URL are persisted.
const allowed = new Set(["chatgpt.com", "chat.openai.com"]);
const dayMs = 86400000, maxEvents = 5000;
const bucketMs = 5*60000, bucketPrefix = "synrex.events.";
const inMemory = new Map();
let eventWrites = Promise.resolve();
let sessionWrites = Promise.resolve();
let sincePrune=0;
function accept(d) {
  try { return allowed.has(new URL(d.url).hostname); } catch { return false; }
}
function kind(type) {
  return ["main_frame","sub_frame","xmlhttprequest","websocket","other"].includes(type) ? type : "other";
}
function endpoint(d) {
  try {
    const url = new URL(d.url);
    if (url.protocol==="wss:")return "websocket_handshake";
    if (url.pathname === "/favicon.ico" && url.searchParams.has("_synrex_probe")) return "self_test";
    if (/^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(url.pathname)) return "conversation";
    return "other";
  } catch { return "other"; }
}
const requestKey = d => d.tabId + ":" + d.requestId;
const nowIso = n => new Date(n).toISOString();
function append(event) {
  eventWrites = eventWrites.then(async () => {
    const ts = Date.now();
    const key=bucketPrefix+Math.floor(ts/bucketMs);
    const bucket=await chrome.storage.local.get(key);
    const current=Array.isArray(bucket[key])?bucket[key]:[];
    current.push({ ...event, ts });
    // Write only a five-minute shard, not the entire seven-day history on
    // every request lifecycle event.
    await chrome.storage.local.set({[key]:current});
    if(++sincePrune>=500){sincePrune=0;await pruneStorage();}
  }).catch(() => {});
}
async function pruneStorage(){
  const all=await chrome.storage.local.get(null);
  const cutoff=Math.floor((Date.now()-7*dayMs)/bucketMs);
  const keys=Object.keys(all).filter(k=>k.startsWith(bucketPrefix))
    .sort((a,b)=>Number(a.slice(bucketPrefix.length))-Number(b.slice(bucketPrefix.length)));
  let total=keys.reduce((n,k)=>n+(Array.isArray(all[k])?all[k].length:0),0);
  for(const key of keys){
    const index=Number(key.slice(bucketPrefix.length));
    const items=Array.isArray(all[key])?all[key]:[];
    const expired=index<cutoff,extra=Math.max(0,total-maxEvents);
    if(expired || extra>=items.length) {
      await chrome.storage.local.remove(key);
      total-=items.length;
    }else if(extra>0) {
      await chrome.storage.local.set({[key]:items.slice(extra)});
      total-=extra;
    }
  }
}
// Chrome MV3 background service workers may be suspended while a long
// streaming request is open. Persist the in-flight state in storage.session.
function updateSession(key, record) {
  sessionWrites = sessionWrites.then(async () => {
    const {inflight={}} = await chrome.storage.session.get("inflight");
    if(record)inflight[key] = record;
    else delete inflight[key];
    const keys=Object.keys(inflight);
    if(keys.length>600)for(const excess of keys.slice(0,keys.length-600))delete inflight[excess];
    await chrome.storage.session.set({inflight});
  }).catch(() => {});
  return sessionWrites;
}
async function lookup(key) {
  if (inMemory.has(key)) return inMemory.get(key);
  await sessionWrites;
  const {inflight={}}=await chrome.storage.session.get("inflight");
  return inflight[key];
}
function event(record, reason, time, extra={}) {
  append({kind:"network",reason,flowId:record.flowId,tabId:record.tabId,
    host:record.host,requestType:record.requestType,
    endpointGroup:record.endpointGroup,tabAssociation:record.tabId<0?"unknown":"known",
    startedAt:nowIso(record.started),
    durationMs:Math.max(0,Math.round(time-record.started)), ...extra});
}
function start(d){
  if(!accept(d))return;
  const record={flowId:crypto.randomUUID(),started:d.timeStamp,tabId:d.tabId,
    requestType:kind(d.type),endpointGroup:endpoint(d),host:new URL(d.url).hostname};
  const key=requestKey(d);
  inMemory.set(key,record);
  if(inMemory.size>600)inMemory.delete(inMemory.keys().next().value);
  updateSession(key,record);
  event(record,"started",d.timeStamp);
}
function mark(d,reason) {
  if(!accept(d))return;
  void lookup(requestKey(d)).then(record=>{
    if(!record)return;
    event(record,reason,d.timeStamp,{
      ...(Number.isInteger(d.statusCode)?{status:d.statusCode}:{}),
      ...(reason==="redirect"?{redirected:true}:{})
    });
  }).catch(()=>{});
}
function finish(d,reason) {
  if(!accept(d))return;
  const key=requestKey(d);
  void lookup(key).then(record=>{
    if(!record)return;
    event(record,record.endpointGroup==="websocket_handshake"&&reason==="completed"
      ?"handshake_completed":reason,d.timeStamp,{
      ...(Number.isInteger(d.statusCode)?{status:d.statusCode}:{}),
      ...(reason==="network_error"?{errorCategory:
        /timeout|timed.out/i.test(d.error??"")?"timeout":
        /abort|cancel/i.test(d.error??"")?"aborted":
        /disconnect|connection|reset|closed/i.test(d.error??"")?"connection_lost":"network_error"}:{})
    });
    inMemory.delete(key);
    updateSession(key,null);
  }).catch(()=>{});
}
const urls={urls:["https://chatgpt.com/*","https://chat.openai.com/*"]};
chrome.webRequest.onBeforeRequest.addListener(start,urls);
chrome.webRequest.onHeadersReceived.addListener(d=>mark(d,"headers_received"),urls);
chrome.webRequest.onResponseStarted.addListener(d=>mark(d,"first_response"),urls);
chrome.webRequest.onBeforeRedirect.addListener(d=>finish(d,"redirect"),urls);
chrome.webRequest.onCompleted.addListener(d=>finish(d,"completed"),urls);
chrome.webRequest.onErrorOccurred.addListener(d=>finish(d,"network_error"),urls);
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(!sender.tab?.id || !allowed.has((() => {
    try{return new URL(sender.tab.url).hostname;}catch{return "";}
  })()))return;
  if(msg?.kind==="synrex_conversation_title" && typeof msg.title==="string" &&
    msg.title.length<=120 && !/[\x00-\x1f\x7f]/.test(msg.title) && msg.title.trim()){
    append({kind:"conversation_title",reason:"observed",tabId:sender.tab.id,
      conversationTitle:msg.title.trim()});
    reply({recorded:true});return;
  }
  if(msg?.kind==="synrex_visible_error" &&
    ["transport_timeout","network_error","retry_requested"].includes(msg.code)){
    append({kind:"ui",reason:msg.code,tabId:sender.tab.id});
    reply({recorded:true});return;
  }
  if(msg?.kind==="synrex_tab_state" && ["visible","hidden","pagehide","pageshow"].includes(msg.state)){
    append({kind:"tab",reason:msg.state,tabId:sender.tab.id});
    reply({recorded:true});
  }
});
chrome.alarms.create("synrex_inflight_health",{periodInMinutes:1});
chrome.alarms.create("synrex_storage_prune",{periodInMinutes:15});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==="synrex_storage_prune"){
    eventWrites=eventWrites.then(pruneStorage).catch(()=>{});
    return;
  }
  if(alarm.name!=="synrex_inflight_health")return;
  void chrome.storage.session.get("inflight").then(({inflight={}})=>{
    const now=Date.now(),open=Object.values(inflight).filter(r=>now-r.started<30*60000);
    append({kind:"health",reason:"heartbeat",openRequests:open.length});
    const clean=Object.fromEntries(Object.entries(inflight).filter(([,r])=>now-r.started<30*60000));
    if(Object.keys(clean).length!==Object.keys(inflight).length)
      void chrome.storage.session.set({inflight:clean});
  }).catch(()=>{});
});
