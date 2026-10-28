import test from "node:test";
import assert from "node:assert/strict";
import { getEncoding } from "js-tiktoken";
import { countToolInputTokens, countToolOutputTokens, MAX_TOOL_METER_BYTES } from "./console-token-meter.js";

test("counts real tool argument and result text with explicit o200k_base, never wire bytes", () => {
  const encoder=getEncoding("o200k_base");
  const input={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{path:"你好 world"}}};
  assert.equal(countToolInputTokens(input),encoder.encode(JSON.stringify(input.params.arguments)).length);
  const output={jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:"你好 world"}]}};
  const expected=encoder.encode("你好 world").length;
  assert.equal(countToolOutputTokens(JSON.stringify(output),"json"),expected);
  const sse=`event: message\ndata: ${JSON.stringify(output)}\n\n`;
  assert.equal(countToolOutputTokens(sse,"sse"),expected);
  assert.equal(countToolInputTokens({method:"initialize"}),null);
});

test("unknown, oversized, invalid, or image results are not reported as zero tokens", () => {
  assert.equal(countToolOutputTokens("{malformed","json"),null);
  assert.equal(countToolOutputTokens(JSON.stringify({error:{code:-32603}}),"json"),null);
  assert.equal(countToolOutputTokens(JSON.stringify({result:{content:[{type:"image",data:"AA"}]}}),"json"),null);
  assert.equal(countToolInputTokens({method:"tools/call",params:{arguments:{body:"x".repeat(MAX_TOOL_METER_BYTES)}}}),null);
});
