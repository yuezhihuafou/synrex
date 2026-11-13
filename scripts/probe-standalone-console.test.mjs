import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => server.listen(0, "127.0.0.1", yes).once("error", no));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("packaged independent Console serves authenticated HTTP without production state", async t => {
  const cli = resolve("dist-console-server/console-monitor.js");
  const page = resolve("dist-console/monitor-app.html");
  // CI runs unit tests before npm pack / the full build. The Console smoke
  // must be self-contained rather than passing only on a developer checkout
  // that happens to contain stale dist assets.
  if (!existsSync(cli) || !existsSync(page)) {
    execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["build:console"], { cwd: resolve("."), stdio: "pipe", shell: process.platform === "win32", timeout: 90_000 });
  }
  assert.ok(existsSync(cli) && existsSync(page), "run pnpm build before this smoke test");
  const root = mkdtempSync(join(tmpdir(), "synrex-console-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "runs", "monitor"]) mkdirSync(join(root, dir));
  const token = "disposable-console-test-password-20261113";
  const authFile = join(root, "auth.json");
  writeFileSync(authFile, JSON.stringify({ ownerToken: token }), { mode: 0o600 });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    cli, "--state-dir", join(root, "state"), "--run-root", join(root, "runs"),
    "--monitor-dir", join(root, "monitor"), "--auth-file", authFile,
    "--port", String(port), "--host", "127.0.0.1", "--origin", origin,
  ], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root } });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let live = false;
  for (let attempt = 0; attempt < 65; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(700) });
      if (response.ok) { live = true; break; }
    } catch { /* Not yet listening. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(live, "Independent Console did not start: " + stderr.slice(-700));
  const unauthorized = await fetch(origin + "/console/api/snapshot");
  assert.equal(unauthorized.status, 401);
  const rejectedOrigin = await fetch(origin + "/console/api/login", {
    method: "POST", headers: { "origin": "https://not-allowed.example", "content-type": "application/json" },
    body: JSON.stringify({ password: token }),
  });
  assert.equal(rejectedOrigin.status, 403);
  const login = await fetch(origin + "/console/api/login", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: token }),
  });
  assert.equal(login.status, 200, "Login failed: " + stderr.slice(-500));
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(cookie, /^synrex_monitor=/);
  const snapshot = await fetch(origin + "/console/api/snapshot", { headers: { cookie } });
  assert.equal(snapshot.status, 200);
  const content = await snapshot.json();
  assert.equal(typeof content.sampledAt, "string");
  const pageResponse = await fetch(origin + "/console/");
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /<html/i);
  child.kill("SIGTERM");
});
