import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateRelease, assertLockedArchiveEntries, defaultPrefix, installPreparedRelease, parseArgs,
  readCurrent, releasePath, rollbackRelease, runNative, verifyRelease, verifyRunnableRelease,
} from "./portable-install.mjs";

test("portable archives must contain locked, safe, non-traversing paths", () => {
  const valid = ["package/package.json", "package/deploy/release-lock.yaml",
    "package/pnpm-workspace.yaml", "package/dist/cli.js"];
  assert.doesNotThrow(() => assertLockedArchiveEntries(valid));
  assert.throws(() => assertLockedArchiveEntries(valid.filter((x) => x !== "package/deploy/release-lock.yaml")), /missing locked asset/);
  assert.throws(() => assertLockedArchiveEntries([...valid, "package/../../secrets"]), /Unsafe or empty/);
  assert.throws(() => assertLockedArchiveEntries([...valid, "/tmp/outside"]), /Unsafe or empty/);
});

function fixture(t) {
  const prefix = mkdtempSync(join(tmpdir(), "synrex-portable-test-"));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  return prefix;
}
function createReleaseAt(releaseDir, version, needsDependency = false) {
  const dir = join(releaseDir, "node_modules", "synrex");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "synrex", version, type: "module" }));
  writeFileSync(join(dir, "dist", "cli.js"),
    (needsDependency ? 'import "portable-test-dependency";\n' : "") + `console.log("${version}");\n`);
}
function createRelease(prefix, version) {
  createReleaseAt(releasePath(prefix, version), version);
}
function installAbsoluteDependency(dir) {
  const modules = join(dir, "node_modules", "synrex", "node_modules");
  const packageDir = join(modules, ".pnpm", "portable-test-dependency", "node_modules", "portable-test-dependency");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"),
    JSON.stringify({ name: "portable-test-dependency", type: "module", exports: "./index.js" }));
  writeFileSync(join(packageDir, "index.js"), "export default true;\n");
  symlinkSync(packageDir, join(modules, "portable-test-dependency"),
    process.platform === "win32" ? "junction" : "dir");
}

test("portable installer parses safe platform-independent plans", () => {
  const args = parseArgs(["--plan", "--version", "0.3.0", "--prefix", "./qa-stage"]);
  assert.equal(args.version, "0.3.0");
  assert.equal(args.action, "plan");
  assert.ok(args.prefix.endsWith("qa-stage"));
  assert.match(defaultPrefix("win32", "C:\\Users\\test", { LOCALAPPDATA: "C:\\AppData" }), /Synrex/);
  assert.throws(() => parseArgs(["--stage", "--rollback"]), /Choose exactly one/);
  assert.throws(() => parseArgs(["--stage", "--version", "../bad"]), /Invalid release version/);
  assert.throws(() => parseArgs(["--source", "https://example.com/malware.tgz"]), /Synrex GitHub Release/);
});

test("portable release activation and rollback preserve separate versions", (t) => {
  const prefix = fixture(t);
  createRelease(prefix, "0.2.0");
  createRelease(prefix, "0.3.0");
  assert.equal(readCurrent(prefix), null);
  assert.equal(activateRelease(prefix, "0.2.0").version, "0.2.0");
  const next = activateRelease(prefix, "0.3.0");
  assert.equal(next.previous, "0.2.0");
  assert.equal(readCurrent(prefix)?.version, "0.3.0");
  assert.equal(rollbackRelease(prefix).version, "0.2.0");
  assert.equal(readCurrent(prefix)?.previous, "0.3.0");
  assert.equal(verifyRelease(releasePath(prefix, "0.3.0"), "0.3.0").endsWith("cli.js"), true);
});

test("failed verification never moves active pointer", (t) => {
  const prefix = fixture(t);
  createRelease(prefix, "0.2.0");
  activateRelease(prefix, "0.2.0");
  const dest = releasePath(prefix, "0.3.0");
  mkdirSync(dest, { recursive: true });
  assert.throws(() => activateRelease(prefix, "0.3.0"), /incomplete/);
  assert.equal(readCurrent(prefix)?.version, "0.2.0");
  assert.throws(() => verifyRelease(releasePath(prefix, "0.2.0"), "0.3.0"), /mismatch/);
  assert.equal(readFileSync(join(prefix, "current.json"), "utf8").includes("0.2.0"), true);
});

test("dependency links must be created after moving to final version directory", (t) => {
  const prefix = fixture(t);
  const stage = join(prefix, ".stage-fixture");
  const dest = releasePath(prefix, "0.3.0");
  createReleaseAt(stage, "0.3.0", true);
  installPreparedRelease(stage, dest, "0.3.0", (installedDir) => {
    assert.equal(installedDir, dest);
    assert.equal(existsSync(stage), false, "the staging directory must be gone before pnpm runs");
    installAbsoluteDependency(installedDir);
  });
  assert.equal(verifyRunnableRelease(dest, "0.3.0").endsWith("cli.js"), true);
  assert.equal(activateRelease(prefix, "0.3.0").version, "0.3.0");
});

test("a Junction pointing to the removed staging directory must not be activated", (t) => {
  const prefix = fixture(t);
  const stage = join(prefix, ".stage-broken-link");
  const dest = releasePath(prefix, "0.3.0");
  createReleaseAt(stage, "0.3.0", true);
  installAbsoluteDependency(stage);
  mkdirSync(join(prefix, "releases"), { recursive: true });
  renameSync(stage, dest);
  assert.throws(() => verifyRunnableRelease(dest, "0.3.0"), /Release CLI verification failed/);
  assert.throws(() => activateRelease(prefix, "0.3.0"), /Release CLI verification failed/);
  assert.equal(readCurrent(prefix), null);
});

test("a dependency installation failure removes only the incomplete new release", (t) => {
  const prefix = fixture(t);
  createRelease(prefix, "0.2.0");
  activateRelease(prefix, "0.2.0");
  const stage = join(prefix, ".stage-failed");
  const dest = releasePath(prefix, "0.3.0");
  createReleaseAt(stage, "0.3.0");
  assert.throws(() => installPreparedRelease(stage, dest, "0.3.0", () => {
    throw new Error("pnpm registry unavailable");
  }), /pnpm registry unavailable/);
  assert.equal(existsSync(dest), false);
  assert.equal(readCurrent(prefix)?.version, "0.2.0");
  assert.equal(verifyRunnableRelease(releasePath(prefix, "0.2.0"), "0.2.0").endsWith("cli.js"), true);
});

test("native command errors report exit code and stdout when stderr is empty", (t) => {
  const prefix = fixture(t);
  assert.throws(() => runNative(process.execPath,
    ["-e", "console.log('PNPM_DETAIL_FROM_STDOUT'); process.exit(23)"], prefix),
  /exit=23[^]*PNPM_DETAIL_FROM_STDOUT/);
});
