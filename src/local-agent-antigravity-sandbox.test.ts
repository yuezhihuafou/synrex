import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareAntigravityExecution } from "./local-agent-antigravity-sandbox.js";

test("autonomous shell runs without approvals but cannot write host files, git metadata or databases", {
  skip: process.platform !== "linux" || !existsSync("/usr/bin/bwrap"),
}, () => {
  const testRoot = mkdtempSync(join(tmpdir(), "synrex-agy-namespace-test-"));
  const workspace = join(testRoot, "workspace");
  const home = join(testRoot, "home");
  mkdirSync(workspace);
  mkdirSync(join(workspace, ".git"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const hostGuard = join(home, "outside.txt");
  const auth = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const gitGuard = join(workspace, ".git", "HEAD");
  const sensitive = join(workspace, ".env");
  const existingDatabase = join(workspace, "history.sqlite");
  writeFileSync(hostGuard, "HOST_STAYS");
  writeFileSync(auth, "AUTH_STAYS");
  writeFileSync(gitGuard, "GIT_STAYS");
  writeFileSync(sensitive, "SECRET_STAYS");
  writeFileSync(existingDatabase, "DATABASE_STAYS");
  try {
    const plan = prepareAntigravityExecution({
      workspaceRoot: workspace,
      providerCommand: "/bin/sh",
      providerArgs: ["-c", [
        "echo OK > created.txt",
        "echo BAD > ../home/outside.txt 2>/dev/null || :",
        "echo BAD > .git/HEAD 2>/dev/null || :",
        "echo BAD > .env 2>/dev/null || :",
        "echo BAD > history.sqlite 2>/dev/null || :",
        "echo WRITABLE > /tmp/sandbox-temp",
        'echo REPLACED > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"',
        "test -e /tmp/sandbox-temp && echo TEMP_OK",
      ].join("; ")],
      writeMode: "allowed",
      env: { ...process.env, HOME: home },
    });
    try {
      assert.equal(plan.command, existsSync("/usr/local/libexec/synrex-bwrap")
        ? "/usr/local/libexec/synrex-bwrap" : "bwrap");
      const ran = spawnSync(plan.command, plan.args, {
        env: plan.env, cwd: workspace, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(ran.status, 0, ran.stderr);
      assert.match(ran.stdout, /TEMP_OK/);
      assert.equal(readFileSync(join(workspace, "created.txt"), "utf8").trim(), "OK");
      assert.equal(readFileSync(hostGuard, "utf8"), "HOST_STAYS");
      assert.equal(readFileSync(gitGuard, "utf8"), "GIT_STAYS");
      assert.equal(readFileSync(sensitive, "utf8"), "SECRET_STAYS");
      assert.equal(readFileSync(existingDatabase, "utf8"), "DATABASE_STAYS");
      assert.equal(readFileSync(auth, "utf8"), "AUTH_STAYS");
      assert.equal(existsSync("/tmp/sandbox-temp"), false);
    } finally { plan.close(); }

    const readonly = prepareAntigravityExecution({
      workspaceRoot: workspace,
      providerCommand: "/bin/sh",
      providerArgs: ["-c", "echo NO > forbidden.txt 2>/dev/null || :; echo READ_OK"],
      writeMode: "read_only",
      env: { ...process.env, HOME: home },
    });
    try {
      const ran = spawnSync(readonly.command, readonly.args, {
        env: readonly.env, cwd: workspace, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(ran.status, 0, ran.stderr);
      assert.match(ran.stdout, /READ_OK/);
      assert.equal(existsSync(join(workspace, "forbidden.txt")), false);
    } finally { readonly.close(); }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Synrex-scoped bwrap permits nested terminal sandboxes when installed", {
  skip: process.platform !== "linux" || !existsSync("/usr/local/libexec/synrex-bwrap"),
}, () => {
  const ran = spawnSync("/usr/local/libexec/synrex-bwrap", [
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev-bind", "/dev", "/dev",
    "--", "bwrap", "--ro-bind", "/", "/", "--proc", "/proc",
    "--dev-bind", "/dev", "/dev", "--", "/bin/true",
  ], { encoding: "utf8", timeout: 12_000 });
  assert.equal(ran.status, 0, ran.stderr || ran.error?.message);
});
