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
  assert.match(win["register-synrex-task.ps1"], /wscript\.exe/);
  assert.match(win["register-synrex-task.ps1"], /start-synrex-hidden\.vbs/);
  assert.match(win["register-synrex-task.ps1"], /RestartCount 20/);
  assert.match(win["register-synrex-task.ps1"], /MultipleInstances IgnoreNew/);
  assert.match(win["start-synrex-hidden.vbs"], /shell\.Run\(command, 0, True\)/);
  assert.match(win["start-synrex-hidden.vbs"], /start-synrex-logged\.ps1/);
  assert.ok(win["start-synrex-logged.ps1"].includes("C:\\Program Files\\nodejs\\node.exe"));
  assert.match(win["start-synrex-logged.ps1"], /RedirectStandardOutput/);
  assert.match(win["start-synrex-logged.ps1"], /RedirectStandardError/);
  assert.match(win["start-synrex.cmd"], /"C:\\Program Files\\nodejs\\node.exe"/);
  assert.throws(() => renderServiceFiles("freebsd", "/tmp/a"), /only/);
});

test("service definitions are additive and refuse overwriting unexpected changes", t => {
  const root = mkdtempSync(join(tmpdir(), "synrex-service-generate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(releasePath(root, "0.3.0"), "node_modules", "synrex");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), '{"name":"synrex","version":"0.3.0"}');
  // Activation now validates the real CLI version, not just the package metadata.
  writeFileSync(join(pkg, "dist", "cli.js"), "console.log('0.3.0')");
  activateRelease(root, "0.3.0");
  const paths = writeServiceFiles(root, "linux");
  assert.equal(paths.length, 1);
  assert.deepEqual(writeServiceFiles(root, "linux"), paths);
  const win = writeServiceFiles(root, "win32");
  const vbs = win.find(path => path.endsWith(".vbs"));
  const ps1 = win.find(path => path.endsWith(".ps1"));
  assert.ok(vbs && ps1);
  assert.deepEqual([...readFileSync(vbs).subarray(0, 2)], [0xff, 0xfe]);
  assert.deepEqual([...readFileSync(ps1).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(writeServiceFiles(root, "win32"), win);
  writeFileSync(paths[0], "modified");
  assert.throws(() => writeServiceFiles(root, "linux"), /refusing to replace/);
  assert.equal(readFileSync(paths[0], "utf8"), "modified");
});
