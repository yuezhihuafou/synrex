import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { openDatabase } from "./db/client.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

test("worktrees prune removes only managed worktrees unused for three days", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cli-worktree-test-"));
  const sourceRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const oldWorktree = join(worktreeRoot, "old");
  const recentWorktree = join(worktreeRoot, "recent");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(sourceRoot);
  await mkdir(worktreeRoot);
  await writeFile(join(sourceRoot, "README.md"), "initial\n");
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["config", "user.email", "devspace@example.com"]);
  await git(sourceRoot, ["config", "user.name", "DevSpace Test"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "Initial commit"]);
  await git(sourceRoot, ["worktree", "add", "--detach", oldWorktree, "HEAD"]);
  await git(sourceRoot, ["worktree", "add", "--detach", recentWorktree, "HEAD"]);

  const baseSha = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({
    id: "ws_old",
    root: oldWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.createSession({
    id: "ws_recent",
    root: recentWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.close();

  const database = openDatabase(stateDir);
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = 'ws_old'")
    .run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString());
  database.close();

  const env = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [sourceRoot], worktreeRoot },
    storage: { stateDir },
  });

  t.after(async () => {
    await git(sourceRoot, ["worktree", "remove", "--force", oldWorktree]).catch(() => undefined);
    await git(sourceRoot, ["worktree", "remove", "--force", recentWorktree]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "worktrees", "prune"],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );

  assert.match(stdout, /Pruned 1 stale managed worktree\./);
  assert.equal(await pathExists(oldWorktree), false);
  assert.equal(await pathExists(recentWorktree), true);
});

test("serve does not run recovery-aware managed worktree pruning on the startup path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cli-startup-worktree-test-"));
  const sourceRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const staleWorktree = join(worktreeRoot, "stale");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(sourceRoot);
  await mkdir(worktreeRoot);
  await writeFile(join(sourceRoot, "README.md"), "initial\n");
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["config", "user.email", "devspace@example.com"]);
  await git(sourceRoot, ["config", "user.name", "DevSpace Test"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "Initial commit"]);
  await git(sourceRoot, ["worktree", "add", "--detach", staleWorktree, "HEAD"]);

  const baseSha = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({
    id: "ws_stale_startup",
    root: staleWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.close();
  const database = openDatabase(stateDir);
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = 'ws_stale_startup'")
    .run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString());
  database.close();

  const port = await freePort();
  const env = writeTestDevspaceConfig(configDir, {
    server: { host: "127.0.0.1", port },
    workspaces: { allowedRoots: [sourceRoot], worktreeRoot },
    storage: { stateDir },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, "serve"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await git(sourceRoot, ["worktree", "remove", "--force", staleWorktree]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Synrex exited before health readiness. stdout=${Buffer.concat(stdout).toString("utf8")} stderr=${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    try {
      const response = await fetch(healthUrl);
      if (response.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, "Synrex should become healthy without pruning managed worktrees first");
  assert.equal(await pathExists(staleWorktree), true);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a test port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}
