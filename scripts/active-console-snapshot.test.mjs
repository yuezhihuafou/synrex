import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveActiveConsoleRelease } from "../deploy/observability/active-console-snapshot.mjs";

test("Console collector follows only the active, immutable release identity", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "synrex-console-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = "b".repeat(40), fingerprint = "stable-build";
  const release = path.join(root, "synrex-main-" + sha.slice(0, 12));
  mkdirSync(path.join(release, "dist"), { recursive: true });
  const manifest = { release: path.basename(release), sourceRevision: sha, sourceDirty: false,
    sourceFingerprint: fingerprint };
  const build = { revision: sha, dirty: false, sourceFingerprint: fingerprint };
  const save = () => {
    writeFileSync(path.join(release, "release-manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(release, "dist", "build-info.json"), JSON.stringify(build));
  };
  save();
  const state = (p) => `ActiveState=active\nExecStart={ argv[]=/usr/bin/node ${p}/dist/cli.js serve ; }`;
  assert.equal(resolveActiveConsoleRelease(state(release), root), release);
  assert.throws(() => resolveActiveConsoleRelease(state(release).replace("ActiveState=active", "ActiveState=failed"), root),
    /not active/);
  assert.throws(() => resolveActiveConsoleRelease("ActiveState=active\nExecStart=none", root),
    /exactly one/);
  const alias = path.join(root, "synrex-main-alias");
  symlinkSync(release, alias);
  assert.throws(() => resolveActiveConsoleRelease(state(alias), root),
    /real immutable directory/);
  manifest.sourceRevision = "c".repeat(40);
  save();
  assert.throws(() => resolveActiveConsoleRelease(state(release), root),
    /identity disagree/);
  manifest.sourceRevision = sha; build.sourceFingerprint = "different";
  save();
  assert.throws(() => resolveActiveConsoleRelease(state(release), root),
    /identity disagree/);
  build.sourceFingerprint = fingerprint;
  save();
  const outside = path.join(os.tmpdir(), "not-a-release");
  assert.throws(() => resolveActiveConsoleRelease(state(outside), root),
    /approved immutable release root/);
});
