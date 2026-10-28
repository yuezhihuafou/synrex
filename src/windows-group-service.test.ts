import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("Windows deployment uses source-owned launchers and per-node Console identity", async () => {
  const installer = await readFile(resolve("deploy/windows/install-console-desktop.ps1"), "utf8");
  const launcher = await readFile(resolve("deploy/windows/start-synrex-console.ps1"), "utf8");
  const deploy = await readFile(resolve("deploy/windows/deploy-group.ps1"), "utf8");
  const desktop = await readFile(resolve("deploy/windows/desktop/main.cjs"), "utf8");
  assert.match(installer, /start-synrex-console\.ps1/);
  assert.match(installer, /Synrex Console\.lnk/);
  assert.doesNotMatch(installer, /\.Replace\(/);
  assert.match(launcher, /Synrex Group Core/);
  assert.match(launcher, /SYNREX_CONSOLE_PROFILE_DIR/);
  assert.match(launcher, /17678/);
  assert.match(deploy, /prepare-runtime-slot\.ps1/);
  assert.match(deploy, /-Action Activate/);
  assert.match(deploy, /install-console-desktop\.ps1/);
  assert.match(desktop, /app\.setPath\("userData", profileRoot\)/);
  assert.match(desktop, /DEVSPACE_PLATFORM_ROOT/);
});

test("Windows Group startup rejects wrong credentials, endpoints and occupied ports", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "synrex-group-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "state/devspace-config");
  const secretDir = join(root, "state/secrets");
  const slot = join(root, "runtime/slots/synrex-windows-test");
  for (const dir of [configDir, secretDir, join(root, "logs"), join(slot, "node"), join(slot, "devspace/node_modules/@waishnav/devspace/dist")]) await mkdir(dir, { recursive: true });
  for (const file of ["node/node.exe", "devspace/node_modules/@waishnav/devspace/dist/cli.js", "READY", "slot.json"]) await writeFile(join(slot, file), "");
  await writeFile(join(root, "runtime/active-slot.txt"), "synrex-windows-test");
  const config = { server: { host: "127.0.0.1", port: 17677, publicBaseUrl: "https://dev.sanqi.org/group" } };
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(config));
  const tokenFile = join(secretDir, "cloudflare-tunnel-token.txt");
  await writeFile(tokenFile, Buffer.from(JSON.stringify({ t: "wrong", s: "test-only" })).toString("base64"));
  const invoke = () => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("deploy/windows/group-service.ps1"), "-Action", "Run", "-PlatformRoot", root], { timeout: 15000 });
  await assert.rejects(invoke, /credential identity mismatch/);
  await writeFile(tokenFile, Buffer.from(JSON.stringify({ t: "edbf2dd7-2cc1-434c-979a-2f6b387eebe3", s: "test-only" })).toString("base64"));
  config.server.port = 17678;
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(config));
  await assert.rejects(invoke, /non-Group endpoint/);
  config.server.port = 17677;
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(config));
  const identity = await exec("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CreationDate.ToUniversalTime().ToString('o')`]);
  const receipt = join(root, "state/group-service-core.json");
  await writeFile(receipt, JSON.stringify({ slot: "synrex-windows-test", pid: process.pid, created: identity.stdout.trim() }));
  await assert.rejects(invoke);
  assert.match(await readFile(join(root, "logs/group-service.log"), "utf8"), /Recorded Group Core identity does not match/);
  await rm(receipt);
  const listener = createServer();
  await new Promise<void>((done, reject) => {
    listener.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? done() : reject(error));
    listener.listen(17677, "127.0.0.1", done);
  });
  t.after(() => { if (listener.listening) listener.close(); });
  await assert.rejects(invoke);
  assert.match(await readFile(join(root, "logs/group-service.log"), "utf8"), /Port 17677 is occupied/);
});
