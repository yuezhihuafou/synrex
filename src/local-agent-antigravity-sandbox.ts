import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

export interface AntigravityExecutionPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Keep private credentials/session copies out of the real worktree. */
  close(): void;
}

/**
 * CLI auto-approval is not a filesystem boundary. Never turn on blanket
 * approval without also constraining the launched process with an OS mount
 * namespace: only the active workspace and ephemeral CLI state are writable.
 *
 * Read-only turns mount the workspace read-only but can still run commands
 * that generate temporary files in a private /tmp. Write turns do not expose
 * the host Git metadata, Docker socket, SSH keys, or production state as
 * writable filesystem mounts. This is NOT a network isolation boundary.
 */
export function prepareAntigravityExecution(options: {
  workspaceRoot: string;
  providerCommand: string;
  providerArgs: string[];
  writeMode?: LocalAgentWriteMode;
  env: NodeJS.ProcessEnv;
}): AntigravityExecutionPlan {
  if (process.platform !== "linux") {
    throw new Error("Autonomous Antigravity requires verified Linux filesystem isolation.");
  }
  const workspace = realpathSync(options.workspaceRoot);
  const userHome = resolve(options.env.HOME || homedir());
  if (workspace === "/" || workspace === userHome || userHome.startsWith(workspace + sep)) {
    throw new Error("Autonomous agents require a project workspace, not the host home or filesystem root.");
  }
  const state = join(userHome, ".gemini", "antigravity-cli");
  if (!existsSync(state)) throw new Error("Antigravity login state is unavailable.");

  const scratch = mkdtempSync(join(tmpdir(), "synrex-agy-private-"));
  try {
    const copiedState = join(scratch, "antigravity-cli");
    // Local reflink copy is usually sub-second. Never let a headless agent
    // modify the logged-in account's persistent sessions or authentication.
    const copied = spawnSync("cp", ["-a", "--reflink=auto", state, copiedState], {
      timeout: 8_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (copied.error || copied.status !== 0) {
      throw new Error("Unable to prepare private Antigravity state: " +
        (copied.error?.message ?? copied.stderr.slice(-400)));
    }

    const root = join(userHome, ".gemini", "antigravity-cli");
    const args = [
      "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--new-session",
      "--ro-bind", "/", "/",
      // The host /tmp is not writable or visible. A workspace under /tmp
      // is restored explicitly in the subsequent scoped bind.
      "--tmpfs", "/tmp",
      "--dir", workspace,
      options.writeMode === "read_only" ? "--ro-bind" : "--bind",
      workspace, workspace,
    ];
    const git = join(workspace, ".git");
    if (options.writeMode !== "read_only" && existsSync(git) &&
        !lstatSync(git).isSymbolicLink()) {
      args.push("--ro-bind", git, git);
    }
    // Private per-turn state. Any auth refresh or cache writes are discarded
    // after the run; the host's canonical login stays unchanged.
    args.push("--dir", root, "--bind", copiedState, root);
    for (const path of [".ssh", ".aws", ".gnupg", ".kube", ".docker"]) {
      const dest = join(userHome, path);
      if (existsSync(dest)) args.push("--tmpfs", dest);
    }
    // A local Docker socket would otherwise let a sandboxed subprocess
    // mutate host files by requesting privileged container operations.
    if (existsSync("/run/docker.sock")) {
      args.push("--ro-bind", "/dev/null", "/run/docker.sock");
    }
    for (const name of [".env", ".env.local", ".env.production", ".git-credentials"]) {
      const dest = join(workspace, name);
      if (existsSync(dest) && lstatSync(dest).isFile()) {
        args.push("--ro-bind", "/dev/null", dest);
      }
    }
    for (const database of existingDatabaseFiles(workspace)) {
      // Existing databases inside the selected code workspace are read-only.
      // Disposable test databases created during the run are still writable.
      args.push("--ro-bind", database, database);
    }
    args.push(
      "--dev-bind", "/dev", "/dev", "--proc", "/proc",
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "XDG_CACHE_HOME", "/tmp/synrex-cache",
      "--setenv", "npm_config_cache", "/tmp/synrex-npm-cache",
      "--setenv", "PIP_CACHE_DIR", "/tmp/synrex-pip-cache",
      "--unsetenv", "SSH_AUTH_SOCK",
      "--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
      "--unsetenv", "DOCKER_HOST",
      "--chdir", workspace, "--",
      options.providerCommand, ...options.providerArgs,
    );
    return {
      // Ubuntu 24.04's distro bwrap-userns-restrict profile permits the
      // outer sandbox but blocks nested user namespaces required by some
      // Antigravity terminal tools. A root-owned Synrex-specific bwrap
      // executable has an independently attached AppArmor userns profile.
      // Other hosts continue to use their normal distro executable.
      command: options.env.SYNREX_ANTIGRAVITY_BWRAP ||
        (existsSync("/usr/local/libexec/synrex-bwrap")
          ? "/usr/local/libexec/synrex-bwrap" : "bwrap"),
      args,
      env: scrubInheritedSecrets(options.env),
      close: () => { rmSync(scratch, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function existingDatabaseFiles(root: string): string[] {
  const protectedFiles: string[] = [];
  let visited = 0;
  const walk = (folder: string, depth: number): void => {
    if (depth > 4 || visited > 2_000 || protectedFiles.length >= 32) return;
    let items: Array<{
      name: string;
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try { items = readdirSync(folder, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      if (++visited > 2_000 || protectedFiles.length >= 32) break;
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isFile() && /\.(?:sqlite(?:3)?|db(?:3)?)(?:-wal|-shm)?$/i.test(item.name)) {
        protectedFiles.push(path);
      } else if (item.isDirectory() && ![
        ".git", "node_modules", ".venv", "venv", "dist", "build", ".cache",
      ].includes(item.name)) {
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 0);
  return protectedFiles;
}

function scrubInheritedSecrets(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DEVSPACE_AUTH_TOKEN|DEVSPACE_OWNER_PASSWORD|KUBECONFIG|SSH_AUTH_SOCK)$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}
