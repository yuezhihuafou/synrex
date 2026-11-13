import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRelease, releasePath } from "./portable-install.mjs";
import { renderServiceFiles, writeServiceFiles } from "./portable-service.mjs";

test("service definitions render for Linux/macOS/Windows without registering a service", () => {
  const linux = renderServiceFiles("linux", "/tmp/Synrex My Project", "/usr/bin/node");
  assert.match(linux["synrex-portable.service"], /ExecStart="\/usr\/bin\/node"/);
  assert.match(linux["synrex-portable.service"], /WorkingDirectory="\/tmp\/Synrex My Project"/);
  const mac = renderServiceFiles("darwin", "/Users/a & b/Synrex", "/usr/local/bin/node");
  assert.match(mac["org.synrex.portable.plist"], /a &amp; b/);
  const win = renderServiceFiles("win32", "C:\\Users\\user\\Synrex", "C:\\Program Files\\nodejs\\node.exe");
  assert.match(win["register-synrex-task.ps1"], /Get-ScheduledTask/);
  assert.match(win["start-synrex.cmd"], /"C:\\Program Files\\nodejs\\node.exe"/);
  assert.throws(() => renderServiceFiles("freebsd", "/tmp/a"), /only/);
});

test("service definitions are additive and refuse overwriting unexpected changes", t => {
  const root = mkdtempSync(join(tmpdir(), "synrex-service-generate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(releasePath(root, "0.3.0"), "node_modules", "synrex");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), '{"name":"synrex","version":"0.3.0"}');
  writeFileSync(join(pkg, "dist", "cli.js"), "console.log('x')");
  activateRelease(root, "0.3.0");
  const paths = writeServiceFiles(root, "linux");
  assert.equal(paths.length, 1);
  assert.deepEqual(writeServiceFiles(root, "linux"), paths);
  writeFileSync(paths[0], "modified");
  assert.throws(() => writeServiceFiles(root, "linux"), /refusing to replace/);
  assert.equal(readFileSync(paths[0], "utf8"), "modified");
});
