// Only metadata. No request body, response body, URL path, query, cookies,
// authorization headers, prompt, model text or page content is stored.
const allowHosts = new Set(["chatgpt.com", "chat.openai.com"]);
const active = new Map();
let queue = Promise.resolve();
const dayMs = 86400000, maxEvents = 5000;
function category(type) {
  return ["main_frame","sub_frame","xmlhttprequest","websocket","other"].includes(type)
    ? type : "other";
}
function append(event) {
  queue = queue.then(async () => {
    const stored = await chrome.storage.local.get("events");
    const now = Date.now(), old = Array.isArray(stored.events) ? stored.events : [];
    const recent = old.filter(e => typeof e.ts === "number" && now-e.ts < 7*dayMs);
    recent.push({ ...event, ts: now });
    await chrome.storage.local.set({events:recent.slice(-maxEvents)});
  }).catch(() => {});
}
function accept(details) {
  try { return allowHosts.has(new URL(details.url).hostname); } catch { return false; }
}
function key(details) { return String(details.tabId)+":"+details.requestId; }
function start(details) {
  if(details.tabId < 0 || !accept(details))return;
  active.set(key(details),{started:details.timeStamp,tabId:details.tabId,
    requestType:category(details.type),host:new URL(details.url).hostname});
  if(active.size > 2000)active.clear();
}
function finish(details, reason) {
  const data=active.get(key(details));if(!data)return;
  active.delete(key(details));
  append({kind:"network",reason,host:data.host,requestType:data.requestType,
    tabId:data.tabId,startedAt:new Date(data.started).toISOString(),
    durationMs:Math.max(0,Math.round(details.timeStamp-data.started)),
    ...(Number.isInteger(details.statusCode)?{status:details.statusCode}:{}),
    ...(reason==="network_error"?{errorCategory:
      /timeout/i.test(details.error??"")?"timeout":/abort/i.test(details.error??"")?"aborted":"network_error"}:{})});
}
chrome.webRequest.onBeforeRequest.addListener(start,
  {urls:["https://chatgpt.com/*","https://chat.openai.com/*"]});
chrome.webRequest.onCompleted.addListener(d=>finish(d,"completed"),
  {urls:["https://chatgpt.com/*","https://chat.openai.com/*"]});
chrome.webRequest.onErrorOccurred.addListener(d=>finish(d,"network_error"),
  {urls:["https://chatgpt.com/*","https://chat.openai.com/*"]});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg?.kind!=="synrex_visible_error" || !sender.tab?.id ||
    !["transport_timeout","network_error","retry_requested"].includes(msg.code))return;
  append({kind:"ui",reason:msg.code,tabId:sender.tab.id,host:"chatgpt.com"});
  reply({recorded:true});
});
