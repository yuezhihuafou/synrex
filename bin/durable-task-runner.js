#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const requestPath = process.argv[2];
if (!requestPath) {
  console.error("usage: durable-task-runner <request.json>");
  process.exit(2);
}

const sourceUrl = new URL("../src/durable-task-runner.ts", import.meta.url);
let runner;
if (existsSync(fileURLToPath(sourceUrl))) {
  try {
    await import("tsx/esm");
  } catch (error) {
    throw new Error(
      "Synrex source checkout detected, but tsx is unavailable. Run `pnpm install` in the checkout; refusing to launch a stale durable runner.",
      { cause: error },
    );
  }
  runner = await import(sourceUrl.href);
} else {
  runner = await import(new URL("../dist/durable-task-runner.js", import.meta.url).href);
}

process.exit(await runner.runDurableTask(requestPath));
