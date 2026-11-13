import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateRelease, defaultPrefix, parseArgs, readCurrent, releasePath,
  rollbackRelease, verifyRelease,
} from "./portable-install.mjs";

function fixture(t) {
  const prefix = mkdtempSync(join(tmpdir(), "synrex-portable-test-"));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  return prefix;
}
function createRelease(prefix, version) {
  const dir = join(releasePath(prefix, version), "node_modules", "synrex");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "synrex", version }));
  writeFileSync(join(dir, "dist", "cli.js"), "console.log('fixture');\n");
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
