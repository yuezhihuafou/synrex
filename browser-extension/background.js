// MV3 lightweight network recorder. Metadata only; no bodies, query, cookies or headers.
const KEY = "synrexTraceV2";
const WINDOW_MS = 2 * 60 * 1000;
const MAX_EVENTS = 1200;
const started = new Map();
let events = [];
let loaded = false;
let saving = Promise.resolve();
async function load() {
  if (loaded) return;
  const stored = await chrome.storage.local.get(KEY);
  if (loaded) return;
  events = Array.isArray(stored[KEY]?.events) ? stored[KEY].events.slice(-MAX_EVENTS) : [];
  loaded = true;
}
function save() {
  saving = saving.catch(()=>{}).then(()=>chrome.storage.local.set({[KEY]:{events}}));
}
function safePath(raw) {
  // Drop IDs and other per-user identifiers from the path.
  return raw.split("/").slice(0,7).map(segment =>
    /^[0-9a-f]{8}-[0-9a-f-]{12,}$/i.test(segment) || segment.length > 60 ? ":id" : segment
  ).join("/").slice(0,180);
}
async function capture(details, failed) {
  const start = started.get(details.requestId);
  started.delete(details.requestId);
  if (!start) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  await load();
  const event = {at:new Date(start.time).toISOString(),durationMs:Math.max(0,details.timeStamp-start.time),
    host:url.host,path:safePath(url.pathname),method:start.method,status:failed?0:details.statusCode,
    error:failed?String(details.error||"network_error").slice(0,100):""};
  events.push(event);
  const now = Date.now();
  events = events.filter(x=>now-Date.parse(x.at)<WINDOW_MS).slice(-MAX_EVENTS);
  save();
}
const urls={urls:["https://chatgpt.com/*","https://chat.openai.com/*"]};
chrome.webRequest.onBeforeRequest.addListener(d=>{
  if(started.size>3000) started.clear();
  started.set(d.requestId,{time:d.timeStamp,method:d.method});
},urls);
chrome.webRequest.onCompleted.addListener(d=>{void capture(d,false);},urls);
chrome.webRequest.onErrorOccurred.addListener(d=>{void capture(d,true);},urls);
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type!=="synrex-browser-trace-read" ||
    !sender.url?.startsWith("https://devspace.yuezhihuafou.dpdns.org/console"))return;
  void load().then(()=>sendResponse({events:events.slice(-MAX_EVENTS)}))
    .catch(()=>sendResponse({events:[],error:"storage_unavailable"}));
  return true;
});
