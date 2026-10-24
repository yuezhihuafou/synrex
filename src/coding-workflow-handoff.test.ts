import assert from "node:assert/strict";
import test from "node:test";
import { buildCodingWorkflowHandoff } from "./coding-workflow-handoff.js";
import type { CodingWorkflow } from "./coding-workflows.js";

test("handoff reuses workflow revision without asserting stale Git or tests", () => {
  const workflow: CodingWorkflow = {
    workflowId: "wf_123456789012345678901234",
    workspaceRoot: "/tmp/project", title: "Fix recovery",
    goal: "Fix restart recovery", acceptanceCriteria: ["test passes"],
    constraints: ["no production edits"], status: "blocked", revision: 3,
    checkpoint: {
      phase: "testing", summary: "test reported", completedSteps: ["patched parser"],
      nextSteps: ["run test again"], blockers: ["timeout"], checks: ["claimed passed"],
      taskIds: ["task_abc"], agentIds: ["agt_12345678"],
      gitHead: "old", gitStatus: "M src/x.ts",
    }, createdAt: "now", updatedAt: "now",
  };
  const result = buildCodingWorkflowHandoff({
    workflow, workspaceId: "ws_test", workspaceRoot: "/tmp/project",
    liveGit: { gitHead: "new", gitStatus: "" },
    agentEvidence: [{ agentId: "agt_12345678", status: "no_evidence" }],
  });
  assert.equal(result.v, 1);
  assert.equal(result.revision, 3);
  assert.equal(result.checkpointGitMatchesCurrent, false);
  assert.equal(result.checksAreSelfReported, true);
  assert.deepEqual(result.taskIdsToInspect, ["task_abc"]);
  assert.deepEqual(result.nextSteps, ["run test again"]);
  assert.equal(result.agentEvidence[0].status, "no_evidence");
  assert.equal(buildCodingWorkflowHandoff({
    workflow, workspaceId: "ws_test", workspaceRoot: "/tmp/project",
    liveGit: { gitHead: "old", gitStatus: "M src/x.ts" },
  }).checkpointGitMatchesCurrent, true);
});
