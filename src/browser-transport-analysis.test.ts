import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBrowserTransport, type BrowserDiagnostic } from "./browser-transport-analysis.js";
const error:BrowserDiagnostic={kind:"ui",reason:"transport_timeout",ts:100000,tabId:2};
test("browser UI timeout alone cannot prove a Synrex failure",()=>{
  assert.equal(analyzeBrowserTransport([error])[0]?.kind,"unpaired_ui_timeout");
});
test("nearby conversation network failure is suspicious but not exact correlation",()=>{
  const events:BrowserDiagnostic[]=[
    {kind:"network",reason:"started",ts:70000,tabId:2,flowId:"local-random",endpointGroup:"conversation"},
    {kind:"network",reason:"network_error",ts:95000,tabId:2,flowId:"local-random",errorCategory:"connection_lost"},
    error,
  ];
  assert.equal(analyzeBrowserTransport(events)[0]?.kind,"browser_network_error");
  assert.match(analyzeBrowserTransport(events)[0]?.description??"",/不能确认/);
});
test("completed HTTP response does not establish UI delivery",()=>{
  const events:BrowserDiagnostic[]=[
    {kind:"network",reason:"started",ts:70000,tabId:2,flowId:"a",endpointGroup:"conversation"},
    {kind:"network",reason:"completed",ts:95000,tabId:2,flowId:"a",status:200},
    error,
  ];
  assert.equal(analyzeBrowserTransport(events)[0]?.kind,"ambiguous_transport_timeout");
});
test("other browser tabs cannot be joined by time alone",()=>{
  assert.equal(analyzeBrowserTransport([{kind:"network",reason:"network_error",ts:99000,
    tabId:9,flowId:"other",endpointGroup:"conversation"},error])[0]?.candidateFlows,0);
});
