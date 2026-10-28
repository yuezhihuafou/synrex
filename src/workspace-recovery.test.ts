import assert from "node:assert/strict";
import test from "node:test";
import type { CodingWorkflow } from "./coding-workflows.js";
import { workspaceRecoveryHint } from "./workspace-recovery.js";

const entry = (i:number): CodingWorkflow => ({
  workflowId: `wf_${String(i).padStart(24,"0")}`, workspaceRoot:"/work",title:"unit",
  goal:`Deliver original outcome ${i}`,acceptanceCriteria:["working artifact","verified full test"],
  constraints:[],status:"blocked",revision:1,createdAt:"",updatedAt:"",
  checkpoint:{phase:"fix",summary:"partial",completedSteps:[],nextSteps:["repair download and rerun"],
    blockers:[],checks:[],taskIds:["task_1234567890abcdef"]},
});
test("workspace recovery remains bounded and preserves original goal, acceptance, action and IDs",()=>{
  const text=workspaceRecoveryHint(Array.from({length:20},(_,i)=>entry(i)));
  for(const expected of ["ORIGINAL request","Deliver original outcome 0","working artifact",
    "repair download and rerun","task_1234567890abcdef","choose by user's current request"]){
    assert.ok(text.includes(expected),expected);
  }
  assert.ok(text.length<1550);
  assert.doesNotMatch(text,/Deliver original outcome 4/);
});
test("workspace recovery never guesses a goal with no persisted workflow",()=>{
  assert.match(workspaceRecoveryHint([]),/do not invent a goal/);
});
