import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function collectSnapshot(root, slot, readSnapshot, readHistory) {
  const active = (await readFile(path.join(root, "runtime", "active-slot.txt"), "utf8")).trim();
  if (active !== slot) throw new Error("Active Group slot changed");
  const response = await fetch("http://127.0.0.1:17677/group/healthz", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Group Core is not healthy");
  const state = path.join(root, "state", "devspace-state");
  const snapshot = readSnapshot(state, slot);
  if (readHistory) {
    try {
      snapshot.diagnostics.observability.tokens.history = readHistory(state);
    } catch (error) {
      console.error("SYNREX_TOKEN_HISTORY_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
  }
  const dir = path.join(state, "observability");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "console-snapshot.json");
  const temporary = target + "." + process.pid + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function main(root, slot) {
  if (!root || !path.isAbsolute(root) || !/^synrex-windows-[A-Za-z0-9._-]+$/.test(slot ?? "")) {
    throw new Error("Invalid Group root or slot");
  }
  const release = path.join(root, "runtime", "slots", slot, "devspace", "node_modules", "@waishnav", "devspace");
  const { readConsoleSnapshot } = await import(pathToFileURL(path.join(release, "dist", "console-snapshot.js")).href);
  const { updateTokenHistory, tokenHistorySummary } = await import(pathToFileURL(path.join(release, "dist", "console-token-history.js")).href);
  let lastError;
  for (;;) {
    try {
      await collectSnapshot(root, slot, readConsoleSnapshot, (state) => tokenHistorySummary(updateTokenHistory(state)));
      lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) console.error("SYNREX_CONSOLE_SNAPSHOT_UNAVAILABLE", message);
      lastError = message;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    console.error("SYNREX_CONSOLE_SNAPSHOT_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
