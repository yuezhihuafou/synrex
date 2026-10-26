import assert from "node:assert/strict";
import test from "node:test";
import { workflowHandoffText } from "./workflow-handoff.js";
import type { CodingWorkflow } from "./coding-workflows.js";

test("bounded, complete recovery handoff preserves goal, acceptance, task, evidence and next", () => {
  const w: CodingWorkflow = {
    workflowId: "wf_" + "a".repeat(24), workspaceRoot: "/tmp", title: "work",
    goal: "Finish end-to-end user task", acceptanceCriteria: ["publish tested artifact", "prove it runs"],
    constraints: [], status: "blocked", revision: 3, createdAt: "", updatedAt: "",
    checkpoint: { phase:"recover", summary:"Build failed", completedSteps:[],
      nextSteps:["repair dependencies"], blockers:["temporary download outage"], checks:["npm test exit 1"],
      taskIds:["task_aaaaaaaaaaaaaaaa"] },
  };
  const text = workflowHandoffText(w, false);
  for (const phrase of ["Finish end-to-end", "publish tested artifact", "repair dependencies",
    "task_aaaaaaaaaaaaaaaa", "npm test exit 1", "false"]) assert.ok(text.includes(phrase));
  assert.ok(text.length < 1100);
  assert.match(text, /NOT independently verified/);
});
