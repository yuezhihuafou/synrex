import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathWithinRoot, selectWorkspaceNode } from "./placement.js";
import { SqliteControlPlaneStore } from "./store.js";

test("path root matching is conservative across POSIX and Windows paths", () => {
  assert.equal(pathWithinRoot("/home/a/project", "/home/a", "linux"), true);
  assert.equal(pathWithinRoot("/home/ab/project", "/home/a", "linux"), false);
  assert.equal(pathWithinRoot("~/project", "/home/a", "linux"), false);
  assert.equal(pathWithinRoot("C:\\Work\\Repo", "c:\\work", "win32"), true);
});

test("explicit node selection is rejected when the path is outside that node's roots", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-explicit-root-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "main",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, homeDir: "/home/main", workspaceRoots: ["/home/main"] },
  });
  store.registerRemoteNode({
    id: "node_gpu_explicit",
    alias: "gpu",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, homeDir: "/home/gpu", workspaceRoots: ["/srv/projects"] },
  });
  assert.throws(
    () => selectWorkspaceNode(store, { selector: "gpu", path: "/home/main/app", localNodeId: local.id }),
    /outside the advertised roots.*wrong host/i,
  );
});

test("tilde paths are resolved against the selected node home", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-home-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "main",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, homeDir: "/home/main", workspaceRoots: ["/home/main"] },
  });
  const remote = store.registerRemoteNode({
    id: "node_gpu_home",
    alias: "gpu",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, homeDir: "/home/gpu", workspaceRoots: ["/home/gpu"] },
  });
  assert.equal(selectWorkspaceNode(store, {
    selector: "gpu",
    path: "~/repo",
    localNodeId: local.id,
  }).node.id, remote.id);
});

test("multi-node placement auto-selects only a unique root match", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "dev",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/home/dev"] },
  });
  const remote = store.registerRemoteNode({
    id: "node_gpu",
    alias: "gpu",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/srv/projects"] },
  });

  assert.equal(selectWorkspaceNode(store, {
    path: "/srv/projects/robot",
    localNodeId: local.id,
  }).node.id, remote.id);
  assert.equal(selectWorkspaceNode(store, {
    path: "/home/dev/app",
    localNodeId: local.id,
  }).node.id, local.id);
});

test("multi-node placement fails closed when roots are ambiguous", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-ambiguous-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "one",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/work"] },
  });
  store.registerRemoteNode({
    id: "node_two",
    alias: "two",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/work"] },
  });

  assert.throws(
    () => selectWorkspaceNode(store, { path: "/work/project", localNodeId: local.id }),
    /matches multiple execution nodes.*will not guess/i,
  );
});

test("explicit node selection refuses suspect or draining nodes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-health-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "local",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/local"] },
  });
  const remote = store.registerRemoteNode({
    id: "node_remote_health",
    alias: "gpu",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/gpu"] },
  });
  store.setNodeHealth(remote.id, "suspect");
  assert.throws(
    () => selectWorkspaceNode(store, { selector: "gpu", path: "/gpu/repo", localNodeId: local.id }),
    /suspect/i,
  );
  store.setNodeHealth(remote.id, "draining");
  assert.throws(
    () => selectWorkspaceNode(store, { selector: "gpu", path: "/gpu/repo", localNodeId: local.id }),
    /draining/i,
  );
});

test("required placement rules override model node selection and preferred rules only disambiguate", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-placement-rules-"));
  const store = new SqliteControlPlaneStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const local = store.ensureLocalNode({
    alias: "main",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: { role: "dev" }, workspaceRoots: ["/work"] },
  });
  const robot = store.registerRemoteNode({
    id: "node_robot",
    alias: "robot",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: { role: "robot" }, workspaceRoots: ["/work"] },
  });

  const requiredRules = [{
    id: "robot-project",
    pathPrefix: "/work/robot",
    mode: "require" as const,
    labels: { role: "robot" },
  }];
  assert.equal(selectWorkspaceNode(store, {
    path: "/work/robot/controller",
    localNodeId: local.id,
    rules: requiredRules,
  }).node.id, robot.id);
  assert.throws(
    () => selectWorkspaceNode(store, {
      selector: "main",
      path: "/work/robot/controller",
      localNodeId: local.id,
      rules: requiredRules,
    }),
    /violates required placement rule.*wrong host/i,
  );

  const preferredRules = [{
    id: "default-dev",
    pathPrefix: "/work",
    mode: "prefer" as const,
    labels: { role: "dev" },
  }];
  assert.equal(selectWorkspaceNode(store, {
    path: "/work/general",
    localNodeId: local.id,
    rules: preferredRules,
  }).node.id, local.id);
  assert.equal(selectWorkspaceNode(store, {
    selector: "robot",
    path: "/work/general",
    localNodeId: local.id,
    rules: preferredRules,
  }).node.id, robot.id);
});

test("logical project binds ambiguous shared checkout paths to a single node", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synrex-project-binding-"));
  const store = new SqliteControlPlaneStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const local = store.ensureLocalNode({ alias: "swy1", platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/home/swy"] } });
  const gateway = store.registerRemoteNode({ id: "node_gateway_project", alias: "gateway",
    platform: { os: "linux", arch: "x64" },
    capabilities: { toolMode: "codex", features: [], labels: {}, workspaceRoots: ["/home/swy"] } });
  const projectBindings = [
    { project: "synrex", node: "gateway", pathPrefix: "/home/swy/DevSpace" },
    { project: "robotics", node: "swy1", pathPrefix: "/home/swy/robotics" },
  ];
  assert.equal(selectWorkspaceNode(store, { path: "/home/swy/DevSpace", localNodeId: local.id,
    projectBindings }).node.id, gateway.id);
  assert.equal(selectWorkspaceNode(store, { path: "/home/swy/robotics", project: "robotics",
    localNodeId: local.id, projectBindings }).node.id, local.id);
  assert.throws(() => selectWorkspaceNode(store, { path: "/home/swy/DevSpace", project: "synrex",
    selector: "swy1", localNodeId: local.id, projectBindings }), /node override denied/);
  assert.throws(() => selectWorkspaceNode(store, { path: "/home/swy/DevSpace", project: "robotics",
    localNodeId: local.id, projectBindings }), /outside project/);
  assert.throws(() => selectWorkspaceNode(store, { path: "/home/swy/DevSpace", project: "unknown",
    localNodeId: local.id, projectBindings }), /Unknown Synrex project/);
  store.setNodeHealth(gateway.id, "offline");
  assert.throws(() => selectWorkspaceNode(store, { path: "/home/swy/DevSpace", localNodeId: local.id,
    projectBindings }), /offline/);
});
