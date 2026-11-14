import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  consoleSnapshotReleaseMismatch, expectedPinnedConsoleRelease,
} from "./console-release-consistency.js";

test("a stale but freshly timestamped snapshot cannot claim another pinned Owner release", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "synrex-runtime-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sha = "a".repeat(40), releaseName = "synrex-main-" + sha.slice(0, 12);
  const target = path.join(dir, releaseName);
  const dist = path.join(target, "dist");
  mkdirSync(dist, { recursive: true });
  const moduleUrl = pathToFileURL(path.join(dist, "console-router.js")).href;
  assert.equal(expectedPinnedConsoleRelease(moduleUrl), null);
  writeFileSync(path.join(target, "release-manifest.json"), JSON.stringify({
    release: releaseName, sourceRevision: sha, sourceFingerprint: "fp", sourceDirty: false,
  }));
  writeFileSync(path.join(dist, "build-info.json"), JSON.stringify({
    revision: sha, sourceFingerprint: "fp", dirty: false,
  }));
  assert.equal(expectedPinnedConsoleRelease(moduleUrl), releaseName);
  assert.equal(consoleSnapshotReleaseMismatch(releaseName, releaseName), false);
  assert.equal(consoleSnapshotReleaseMismatch("synrex-main-" + "b".repeat(12), releaseName), true);
  assert.equal(consoleSnapshotReleaseMismatch(undefined, releaseName), true);
  assert.equal(consoleSnapshotReleaseMismatch("old", null), false);
  writeFileSync(path.join(dist, "build-info.json"), JSON.stringify({
    revision: "b".repeat(40), sourceFingerprint: "fp", dirty: false,
  }));
  assert.equal(expectedPinnedConsoleRelease(moduleUrl), null, "Never trust a mismatched manifest");
});
