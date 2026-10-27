#!/usr/bin/env node
/**
 * Stable, version-neutral bootstrap for the out-of-process Console collector.
 * Select the worker in the actual pinned Core, never a stale systemd override.
 * This executable has no MCP listener, OAuth keys or release mutation rights.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_SHA = /^[a-f0-9]{40}$/;
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,110}$/;

export function resolveActiveConsoleRelease(execStartText, releaseRoot) {
  if (typeof execStartText !== "string" || !/\bActiveState=active\b/.test(execStartText)) {
    throw new Error("Owner Core is not active; retained Console snapshot must become stale.");
  }
  const root = realpathSync(releaseRoot);
  const matches = [...execStartText.matchAll(/(?:^|[\s=])(\/[^\s;]+\/dist\/cli\.js)(?=[\s;]|$)/g)]
    .map((match) => match[1]);
  if (matches.length !== 1) throw new Error("Expected exactly one pinned Core executable.");
  const release = path.dirname(path.dirname(matches[0]));
  if (path.dirname(release) !== root || !RELEASE_NAME.test(path.basename(release))) {
    throw new Error("Core executable is not inside the approved immutable release root.");
  }
  if (lstatSync(release).isSymbolicLink() || !lstatSync(release).isDirectory() ||
      realpathSync(release) !== release) {
    throw new Error("Core release is not a real immutable directory.");
  }
  const manifest = JSON.parse(readFileSync(path.join(release, "release-manifest.json"), "utf8"));
  const build = JSON.parse(readFileSync(path.join(release, "dist", "build-info.json"), "utf8"));
  if (manifest.release !== path.basename(release) || !SOURCE_SHA.test(manifest.sourceRevision) ||
      manifest.sourceDirty !== false || build.dirty !== false ||
      manifest.sourceRevision !== build.revision ||
      manifest.sourceFingerprint !== build.sourceFingerprint) {
    throw new Error("Pinned Core manifest and build identity disagree.");
  }
  return release;
}

async function main() {
  if (!path.isAbsolute(process.env.SYNREX_STATE_DIR ?? "")) {
    throw new Error("Console snapshot state root must be an absolute path.");
  }
  const releaseRoot = process.env.SYNREX_RELEASE_ROOT ??
    path.join(homedir(), "services", "devspace", "releases");
  const state = execFileSync("systemctl", [
    "--user", "show", "devspace.service", "-p", "ExecStart", "-p", "ActiveState",
  ], { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "ignore"] });
  const release = resolveActiveConsoleRelease(state, releaseRoot);
  process.env.SYNREX_RELEASE_DIR = release;
  await import(pathToFileURL(path.join(release, "deploy", "observability",
    "console-snapshot-worker.mjs")).href);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error("SYNREX_CONSOLE_SNAPSHOT_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
