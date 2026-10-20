import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowCommand } from "./workflow-cli.js";

test("legacy six-tool host can create, checkpoint and resume through local CLI", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-workflow-cli-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const project = join(parent, "project");
  await mkdir(project);
  const config = { stateDir: join(parent, "state"), allowedRoots: [parent] };
  const call = async (args: string[], payload?: object) => {
    const output: string[] = [];
    await runWorkflowCommand(args, config, {
      cwd: project,
      write: (line) => output.push(line),
      readInput: async () => JSON.stringify(payload),
    });
    assert.equal(output.length, 1);
    return JSON.parse(output[0]!) as Record<string, unknown>;
  };
  const created = await call(["create"], {
    title: "Recovery", goal: "Resume real coding", acceptanceCriteria: ["Tests pass"],
    constraints: ["No production mutations"], requestKey: "workflow-cli-replay",
  });
  const id = created.workflowId as string;
  assert.match(id, /^wf_[a-f0-9]{24}$/);
  assert.equal((await call(["create"], {
    title: "Recovery", goal: "Resume real coding", acceptanceCriteria: ["Tests pass"],
    constraints: ["No production mutations"], requestKey: "workflow-cli-replay",
  })).workflowId, id);
  const resumed = await call(["checkpoint", id], {
    expectedRevision: 0, status: "active",
    checkpoint: {
      phase: "testing", summary: "Tests running", completedSteps: ["Code updated"],
      nextSteps: ["Poll test"], blockers: [], checks: [], taskIds: ["task_000123"],
    },
  });
  assert.equal(resumed.revision, 1);
  assert.deepEqual(((await call(["show", id])).workflow as { checkpoint: { nextSteps: string[] } }).checkpoint.nextSteps, ["Poll test"]);
  assert.equal(((await call(["list"])).workflows as unknown[]).length, 1);
  await assert.rejects(call(["checkpoint", id], {
    expectedRevision: 0, status: "active",
    checkpoint: {
      phase: "test", summary: "stale", completedSteps: [], nextSteps: [],
      blockers: [], checks: [], taskIds: [],
    },
  }), /revision conflict/);
  await assert.rejects(call(["show", id, "--workspace", join(parent, "state")]), /not found/);
  await assert.rejects(call(["list", "--workspace", tmpdir()]), /outside allowed roots/);
});
