import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, homedir, hostname, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../config.js";
import { DEVSPACE_VERSION } from "../version.js";
import type { NodeRegistration } from "./protocol.js";

const RUNTIME_FINGERPRINT_FILES = [
  "server",
  "durable-task-runner",
  "durable-tasks",
  "tool-surfaces/codex",
  "multinode/worker-client",
  "multinode/link-hub",
  "multinode/mcp-routing",
  "multinode/router",
  "multinode/gateway-routes",
  "multinode/protocol",
  "local-agent-client",
  "local-agent-router",
  "local-agent-daemon",
  "server-shutdown",
  "cli",
] as const;

export function localNodeRegistration(
  config: ServerConfig,
  options: {
    semanticAvailable: boolean;
    durableTasksAvailable: boolean;
  },
): NodeRegistration {
  const buildSource = readBuildSourceProvenance();
  const checkoutSource = currentCheckoutSourceProvenance();
  const features = [
    "workspace.checkout",
    "workspace.worktree",
    "filesystem.read",
    "filesystem.write",
    "git.review",
    "process.session",
    "project.architecture-governance",
    "project.learning",
  ];
  if (options.durableTasksAvailable) features.push("task.durable");
  if (options.semanticAvailable) features.push("semantic.lsp");
  if (config.subagents.enabled) features.push("agent.subagent");

  return {
    // A null alias used to leave the Console with an opaque node ID, which
    // encouraged old UI code to substitute a hard-coded machine name. Keep
    // an explicit config alias authoritative, otherwise use the actual host.
    alias: config.node.alias ?? hostname(),
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    capabilities: {
      toolMode: config.toolMode,
      features,
      labels: { ...config.node.labels },
      runtime: {
        version: DEVSPACE_VERSION,
        buildFingerprint: runtimeBuildFingerprint(),
        buildSource,
        checkoutSource,
        sourceDrift: sourceProvenanceDrifted(buildSource, checkoutSource),
      },
      homeDir: homedir(),
      workspaceRoots: [...config.allowedRoots],
      resources: {
        logicalCpuCount: cpus().length,
        memoryBytes: totalmem(),
      },
    },
  };
}

export function sourceProvenanceDrifted(
  buildSource: { revision?: string; dirty?: boolean; fingerprint?: string } | undefined,
  checkoutSource: { revision?: string; dirty?: boolean; fingerprint?: string } | undefined,
): boolean | undefined {
  if (!buildSource || !checkoutSource) return undefined;
  if (buildSource.revision && checkoutSource.revision && buildSource.revision !== checkoutSource.revision) {
    return true;
  }
  if (
    buildSource.fingerprint
    && checkoutSource.fingerprint
    && buildSource.fingerprint !== checkoutSource.fingerprint
  ) return true;
  if (buildSource.dirty !== undefined && checkoutSource.dirty !== undefined) {
    return buildSource.dirty !== checkoutSource.dirty;
  }
  return false;
}

export function readBuildSourceProvenance(): {
  revision?: string;
  dirty?: boolean;
  fingerprint?: string;
} | undefined {
  const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
  const file = join(runtimeRoot, "build-info.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof parsed.revision === "string" ? { revision: parsed.revision } : {}),
      ...(typeof parsed.dirty === "boolean" ? { dirty: parsed.dirty } : {}),
      ...(typeof parsed.sourceFingerprint === "string"
        ? { fingerprint: parsed.sourceFingerprint }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function currentCheckoutSourceProvenance(): {
  revision?: string;
  dirty?: boolean;
  fingerprint?: string;
} | undefined {
  const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
  const projectRoot = dirname(runtimeRoot);
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
    const fingerprint = sourceFingerprint(projectRoot);
    return { revision, dirty, fingerprint };
  } catch {
    return undefined;
  }
}

export function sourceFingerprint(projectRoot: string): string {
  const hash = createHash("sha256");
  const files = [
    ...walkSourceFiles(join(projectRoot, "src")).map((file) => ({
      relative: file.slice(projectRoot.length + 1).replaceAll("\\", "/"),
      file,
    })),
    ...["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.build.json"].map((relative) => ({
      relative,
      file: join(projectRoot, relative),
    })),
  ].sort((left, right) => left.relative.localeCompare(right.relative));
  for (const { relative, file } of files) {
    hash.update(relative);
    hash.update("\0");
    if (existsSync(file)) hash.update(readFileSync(file));
    else hash.update("MISSING");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 20);
}

function walkSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export function runtimeBuildFingerprint(): string {
  const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const hash = createHash("sha256");
  for (const relative of RUNTIME_FINGERPRINT_FILES) {
    const file = fileURLToPath(new URL(`./${relative}${extension}`, new URL("../", import.meta.url)));
    hash.update(relative);
    hash.update("\0");
    if (existsSync(file)) hash.update(readFileSync(file));
    else hash.update("MISSING");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 20);
}
