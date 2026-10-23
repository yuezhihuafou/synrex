import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBrowserIncidents } from "./browser-incidents.js";
import type { BrowserEvent } from "./browser-trace.js";
const event=(at:string,status:number,error=""):BrowserEvent=>({at,status,error,host:"chatgpt.com",
  path:"/backend-api/conversations",method:"GET",durationMs:120});
test("incident classifier ignores client-block noise but retains 429 and server failures",()=>{
  const events=[
    event("2026-10-23T07:00:00.000Z",0,"net::ERR_BLOCKED_BY_CLIENT"),
    event("2026-10-23T07:00:01.000Z",0,"net::ERR_ABORTED"),
    event("2026-10-23T07:00:02.000Z",429),
    event("2026-10-23T07:00:03.000Z",503),
  ];
  const incidents=detectBrowserIncidents(events);
  assert.deepEqual(incidents.map(x=>x.trigger.status),[429,503]);
  assert.equal(incidents[0]?.events.length,4);
});
