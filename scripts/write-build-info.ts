import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "../src/multinode/local-node.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const status = git(["status", "--porcelain=v1"]);
const buildInfo = {
  schemaVersion: 1,
  revision: git(["rev-parse", "HEAD"]),
  dirty: status === undefined ? undefined : status.length > 0,
  sourceFingerprint: sourceFingerprint(root),
  builtAt: new Date().toISOString(),
};

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist", "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(JSON.stringify(buildInfo));
