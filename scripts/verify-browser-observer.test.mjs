import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const source=readFileSync(fileURLToPath(new URL("../deploy/observability/browser-extension/background.js",import.meta.url)),"utf8");
function harness() {
  const local={events:[]},session={inflight:{}},handlers={};
  const events=["onBeforeRequest","onHeadersReceived","onResponseStarted","onBeforeRedirect",
    "onCompleted","onErrorOccurred"];
  const chrome={
    storage:{
      local:{async get(key){if(key==null)return structuredClone(local);
        const names=Array.isArray(key)?key:[key];
        return Object.fromEntries(names.filter(k=>k in local).map(k=>[k,structuredClone(local[k])]));},
        async set(update){Object.assign(local,structuredClone(update));},
        async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete local[k];}},
      session:{async get(){return structuredClone(session);},async set(update){Object.assign(session,structuredClone(update));}},
    },
    webRequest:Object.fromEntries(events.map(name=>[name,{addListener(fn){handlers[name]=fn;}}])),
    runtime:{onMessage:{addListener(fn){handlers.message=fn;}}},
    alarms:{create(){},onAlarm:{addListener(fn){handlers.alarm=fn;}}},
  };
  const restart=()=>{
    vm.runInNewContext(source,{chrome,crypto:webcrypto,URL,Map,Date,Object,Promise,Set,
      String,Number,JSON,RegExp,Math,Array,console}, {filename:"background.js"});
  };
  restart();
  const flush=()=>new Promise(resolve=>setTimeout(resolve,30));
  const collected=()=>Object.entries(local).filter(([k])=>k.startsWith("synrex.events."))
    .flatMap(([,v])=>v);
  return {chrome,local,session,handlers,restart,flush,collected};
}
const request=(id,timeStamp,options={})=>({
  tabId:2,requestId:id,timeStamp,statusCode:200,type:"xmlhttprequest",
  url:"https://chatgpt.com/backend-api/conversation?q=secret-token-that-must-not-be-saved",
  ...options,
});
test("captures start, headers, first response, finished and never saves URL/headers/body",async()=>{
  const h=harness(),base=Date.now();
  h.handlers.onBeforeRequest(request("1",base));
  h.handlers.onHeadersReceived(request("1",base+10));
  h.handlers.onResponseStarted(request("1",base+80));
  h.handlers.onCompleted(request("1",base+110));
  await h.flush();
  const rows=h.collected().filter(e=>e.endpointGroup==="conversation");
  assert.deepEqual(rows.map(e=>e.reason),["started","headers_received","first_response","completed"]);
  assert.equal(new Set(rows.map(e=>e.flowId)).size,1);
  assert.equal(rows.at(-1)?.durationMs,110);
  assert.ok(!JSON.stringify(h.collected()).includes("secret-token"));
  assert.ok(!JSON.stringify(h.collected()).includes("backend-api"));
  assert.equal(Object.keys(h.session.inflight).length,0);
});
test("service worker restart during a stream does not discard request linkage",async()=>{
  const h=harness(),base=Date.now();
  h.handlers.onBeforeRequest(request("2",base));
  await h.flush();
  h.restart();
  h.handlers.onResponseStarted(request("2",base+1000));
  h.handlers.onErrorOccurred(request("2",base+1200,{
    error:"net::ERR_CONNECTION_RESET",statusCode:undefined,
  }));
  await h.flush();
  assert.ok(h.collected().some(e=>e.reason==="network_error" &&
    e.errorCategory==="connection_lost"&&e.durationMs===1200));
  assert.equal(h.collected().at(-1)?.netError,"net::ERR_CONNECTION_RESET");
  assert.equal(h.local["synrex.incidents"]?.length,1);
  assert.equal(Object.keys(h.session.inflight).length,0);
});
test("uncompleted streams keep a durable start rather than fabricating failure",async()=>{
  const h=harness();
  h.handlers.onBeforeRequest(request("3",Date.now()));
  await h.flush();
  assert.equal(h.collected()[0].reason,"started");
  assert.equal(h.collected().some(e=>e.reason==="completed"),false);
  h.handlers.alarm({name:"synrex_inflight_health"});
  await h.flush();
  assert.equal(h.collected().at(-1)?.reason,"heartbeat");
  assert.equal(h.collected().at(-1)?.openRequests,1);
});
test("extension rejects unrelated hosts and retains tabless host requests without inventing a tab",async()=>{
  const h=harness();const now=Date.now();
  h.handlers.onBeforeRequest(request("ignored",now,{url:"https://evil.example/api"}));
  h.handlers.onBeforeRequest(request("unknown-tab",now,{tabId:-1}));
  await h.flush();
  assert.equal(h.collected().length,1);
  assert.equal(h.collected()[0].tabAssociation,"unknown");
});
test("websocket handshake completion is not treated as stream delivery",async()=>{
  const h=harness(),now=Date.now();
  h.handlers.onBeforeRequest(request("socket",now,{type:"websocket",url:"wss://chatgpt.com/realtime"}));
  h.handlers.onCompleted(request("socket",now+25,{type:"websocket",url:"wss://chatgpt.com/realtime",statusCode:101}));
  await h.flush();
  assert.equal(h.collected().at(-1)?.reason,"handshake_completed");
  assert.equal(h.collected().at(-1)?.endpointGroup,"websocket_handshake");
});
test("storage pruning keeps at most 5000 recent metadata events",async()=>{
  const h=harness(),now=Date.now(),bucket=Math.floor(now/300000);
  const metadata={kind:"network",reason:"completed",ts:now};
  h.local["synrex.events."+(bucket-5000)]=[metadata];
  h.local["synrex.events."+(bucket-2)]=Array.from({length:4000},()=>({...metadata}));
  h.local["synrex.events."+(bucket-1)]=Array.from({length:2000},()=>({...metadata}));
  h.handlers.alarm({name:"synrex_storage_prune"});
  await new Promise(resolve=>setTimeout(resolve,110));
  assert.equal(h.collected().length,5000);
  assert.equal(h.local["synrex.events."+(bucket-5000)],undefined);
});
test("browser proxy failures have diagnostic error codes without raw URLs",async()=>{
  const h=harness(),now=Date.now();
  h.handlers.onBeforeRequest(request("proxy",now));
  h.handlers.onErrorOccurred(request("proxy",now+22,{
    error:"net::ERR_TUNNEL_CONNECTION_FAILED",statusCode:undefined,
  }));
  await h.flush();
  const row=h.local["synrex.incidents"]?.[0];
  assert.equal(row?.errorCategory,"proxy");
  assert.equal(row?.netError,"net::ERR_TUNNEL_CONNECTION_FAILED");
  assert.ok(!JSON.stringify(row).includes("secret-token"));
});
