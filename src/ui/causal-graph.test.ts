import assert from "node:assert/strict";
import {test} from "node:test";
import {buildCausalGraph} from "./causal-graph.js";
test("task and run ids establish verified edges; browser time only suggests candidates",()=>{
 const request={requestId:"req1",tool:"exec_command",lastAt:"2026-10-23T07:00:00.000Z",taskId:"task1",runId:"run_20261023070000_abcd",classification:"rev_http_completed"};
 const task={id:"task1",runId:"run_20261023070000_abcd",status:"completed",createdAt:request.lastAt};
 const browser={at:request.lastAt,durationMs:100,host:"chatgpt.com",path:"/backend-api/conversation",method:"POST",status:200,error:""};
 const graph=buildCausalGraph([request],[task],[browser]);
 assert.equal(graph.edges.filter(e=>e.confidence==="verified").length,2);
 assert.equal(graph.edges.filter(e=>e.confidence==="temporal").length,1);
 assert.equal(graph.nodes.length,4);
});
