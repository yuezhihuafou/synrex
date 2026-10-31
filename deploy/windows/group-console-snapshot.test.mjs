import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSnapshot } from "./group-console-snapshot.mjs";

test("publishes fresh snapshot only for the active, healthy Core", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synrex-group-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const slot = "synrex-windows-test";
  await mkdir(path.join(root, "runtime"));
  const pointer = path.join(root, "runtime", "active-slot.txt");
  await writeFile(pointer, slot);
  globalThis.fetch = async () => ({ ok: true });
  const target = path.join(root, "state", "devspace-state", "observability", "console-snapshot.json");
  await collectSnapshot(root, slot, () => ({ generatedAt: "first", sourceHealth: { available: true } }));
  assert.equal(JSON.parse(await readFile(target)).generatedAt, "first");
  await collectSnapshot(root, slot, () => ({ generatedAt: "second" }));
  assert.equal(JSON.parse(await readFile(target)).generatedAt, "second");
  globalThis.fetch = async () => ({ ok: false });
  await assert.rejects(collectSnapshot(root, slot, () => ({ generatedAt: "bad" })), /not healthy/);
  assert.equal(JSON.parse(await readFile(target)).generatedAt, "second");
  await writeFile(pointer, "synrex-windows-other");
  await assert.rejects(collectSnapshot(root, slot, () => ({})), /slot changed/);
  assert.equal(JSON.parse(await readFile(target)).generatedAt, "second");
});

test("includes the existing history summary in the published snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synrex-group-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const slot = "synrex-windows-test";
  await mkdir(path.join(root, "runtime"));
  await writeFile(path.join(root, "runtime", "active-slot.txt"), slot);
  globalThis.fetch = async () => ({ ok: true });
  const target = path.join(root, "state", "devspace-state", "observability", "console-snapshot.json");
  await collectSnapshot(root, slot,
    () => ({ diagnostics: { observability: { tokens: {} } } }),
    () => ({ totals: { measuredOutputs: 1 } }));
  assert.equal(JSON.parse(await readFile(target)).diagnostics.observability.tokens.history.totals.measuredOutputs, 1);
});
