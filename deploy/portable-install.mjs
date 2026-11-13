#!/usr/bin/env node
/**
 * Owner-controlled, cross-platform, version-pinned install staging.
 * Never changes a system service, OAuth identity, or an existing installation.
 *
 * Example:
 * node deploy/portable-install.mjs --stage --version 0.3.0
 * node deploy/portable-install.mjs --activate --version 0.3.0
 * node deploy/portable-install.mjs --rollback
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:rc|beta)\.[1-9][0-9]*)?$/;
const defaultVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

export function defaultPrefix(os = platform(), home = homedir(), env = process.env) {
  if (os === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Synrex", "portable");
  if (os === "darwin") return join(home, "Library", "Application Support", "Synrex", "portable");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "synrex", "portable");
}

export function parseArgs(argv) {
  const args = { action: null, version: defaultVersion, prefix: defaultPrefix(), source: null, sha256: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--stage", "--activate", "--rollback", "--status", "--plan", "--help"].includes(arg)) {
      if (args.action) throw new Error("Choose exactly one action.");
      args.action = arg.slice(2);
    } else if (["--version", "--prefix", "--source", "--sha256"].includes(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error("Missing value for " + arg);
      args[arg.slice(2)] = argv[++i];
    } else throw new Error("Unsupported argument: " + arg);
  }
  if (!args.action) args.action = "plan";
  if (!TAG.test(args.version)) throw new Error("Invalid release version.");
  if (args.sha256 && !/^[a-f0-9]{64}$/i.test(args.sha256)) throw new Error("Expected a 64-character SHA-256 digest.");
  args.prefix = resolve(args.prefix);
  if (args.source) {
    if (/^https:\/\//.test(args.source)) {
      const url = new URL(args.source);
      if (url.hostname !== "github.com" ||
          !url.pathname.startsWith("/yuezhihuafou/synrex/releases/download/") ||
          !url.pathname.endsWith(".tgz")) throw new Error("Remote archive must be a Synrex GitHub Release.");
    } else {
      args.source = resolve(args.source);
      if (!args.source.endsWith(".tgz")) throw new Error("A local archive must be a .tgz.");
    }
  }
  return args;
}

export function releasePath(prefix, version) {
  if (!TAG.test(version)) throw new Error("Invalid release version.");
  return join(prefix, "releases", "v" + version);
}

function cliPath(dir) { return join(dir, "node_modules", "synrex", "dist", "cli.js"); }
function packagePath(dir) { return join(dir, "node_modules", "synrex", "package.json"); }
export function verifyRelease(dir, version) {
  if (!existsSync(cliPath(dir)) || !existsSync(packagePath(dir))) throw new Error("Release is incomplete: " + dir);
  const pkg = JSON.parse(readFileSync(packagePath(dir), "utf8"));
  if (pkg.name !== "synrex" || pkg.version !== version) throw new Error("Installed package identity/version mismatch.");
  return cliPath(dir);
}

export function readCurrent(prefix) {
  try {
    const data = JSON.parse(readFileSync(join(prefix, "current.json"), "utf8"));
    if (!TAG.test(data.version) || (data.previous && !TAG.test(data.previous))) throw new Error("Invalid current pointer");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeCurrent(prefix, doc) {
  const path = join(prefix, "current.json"), tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

export function activateRelease(prefix, version) {
  verifyRelease(releasePath(prefix, version), version);
  const old = readCurrent(prefix);
  if (old?.version === version) return { version, previous: old.previous ?? null, unchanged: true };
  const doc = { version, previous: old?.version ?? null, activatedAt: new Date().toISOString() };
  writeCurrent(prefix, doc);
  return doc;
}

export function rollbackRelease(prefix) {
  const old = readCurrent(prefix);
  if (!old?.previous) throw new Error("No previous verified portable release to roll back to.");
  return activateRelease(prefix, old.previous);
}

function checkRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major >= 27 || (major === 22 && minor < 19))
    throw new Error("Synrex requires Node.js >=22.19 and <27.");
}

function installWithNpm(dir, source) {
  const options = { encoding: "utf8", timeout: 240_000, maxBuffer: 128 * 1024, windowsHide: true };
  const args = ["install", "--prefix", dir, "--no-audit", "--no-fund", source];
  const executable = process.platform === "win32" ? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  const result = spawnSync(executable, commandArgs, options);
  if (result.error || result.status !== 0) {
    throw new Error("npm staging failed (existing release untouched): " +
      (result.error?.message ?? result.stderr?.slice(-600) ?? "unknown"));
  }
}

function writeLaunchers(prefix) {
  const bin = join(prefix, "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "synrex.mjs");
  writeFileSync(launcher, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = fileURLToPath(new URL("../", import.meta.url));
const pointer = JSON.parse(readFileSync(join(base, "current.json"), "utf8"));
if (!/^[0-9]+\\.[0-9]+\\.[0-9]+(?:-(?:rc|beta)\\.[1-9][0-9]*)?$/.test(pointer.version)) throw new Error("Invalid release pointer");
const cli = join(base, "releases", "v" + pointer.version, "node_modules", "synrex", "dist", "cli.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  // POSIX path resolution is delegated to Node, avoiding nvm/ASDF hardcoding.
  const unix = join(bin, "synrex");
  writeFileSync(unix, "#!/bin/sh\nexec node \"$(dirname \"$0\")/synrex.mjs\" \"$@\"\n", { mode: 0o755 });
  chmodSync(unix, 0o755);
  writeFileSync(join(bin, "synrex.cmd"), '@echo off\r\nnode "%~dp0synrex.mjs" %*\r\n');
}

function archiveDigest(source, expected) {
  if (!expected) return null;
  if (source.startsWith("https://")) throw new Error("--sha256 requires a local archive. Download it first.");
  const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error("Archive SHA-256 mismatch.");
  return actual;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.action === "help") {
    console.log("Usage: node deploy/portable-install.mjs --plan|--stage|--activate|--rollback|--status [--version X.Y.Z] [--prefix DIR] [--source URL-or-file.tgz] [--sha256 HEX]");
    return;
  }
  checkRuntime();
  const source = args.source ?? `https://github.com/yuezhihuafou/synrex/releases/download/v${args.version}/synrex-${args.version}.tgz`;
  if (args.action === "plan") {
    console.log(JSON.stringify({ action: "plan", os: process.platform, node: process.version,
      prefix: args.prefix, version: args.version, archive: source, serviceChanges: false }, null, 2));
    return;
  }
  if (args.action === "status") {
    console.log(JSON.stringify({ prefix: args.prefix, current: readCurrent(args.prefix) }, null, 2));
    return;
  }
  if (args.action === "activate" || args.action === "rollback") {
    console.log(JSON.stringify(args.action === "activate"
      ? activateRelease(args.prefix, args.version) : rollbackRelease(args.prefix), null, 2));
    return;
  }
  mkdirSync(args.prefix, { recursive: true, mode: 0o700 });
  const lock = join(args.prefix, ".install.lock");
  const fd = openSync(lock, "wx", 0o600);
  try {
    const dest = releasePath(args.prefix, args.version);
    if (!existsSync(dest)) {
      if (!source.startsWith("https://") && !existsSync(source)) throw new Error("Local release archive not found.");
      archiveDigest(source, args.sha256);
      const stage = join(args.prefix, ".stage-" + process.pid + "-" + Date.now());
      mkdirSync(stage, { mode: 0o700 });
      try {
        installWithNpm(stage, source);
        const cli = verifyRelease(stage, args.version);
        const smoke = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 15_000 });
        if (smoke.status !== 0) throw new Error("Installed CLI --version smoke check failed.");
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(stage, dest);
      } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
    } else verifyRelease(dest, args.version);
    writeLaunchers(args.prefix);
    console.log(JSON.stringify({ staged: args.version, prefix: args.prefix, activated: false,
      cli: join(args.prefix, "bin", process.platform === "win32" ? "synrex.cmd" : "synrex"),
      next: "--activate --version " + args.version }, null, 2));
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error("PORTABLE_INSTALL_BLOCKED:", error.message); process.exitCode = 1; }
}
