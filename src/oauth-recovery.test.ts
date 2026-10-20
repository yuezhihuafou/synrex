import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthRecovery } from "./oauth-recovery.js";
import { lockOAuthEnrollment, getOAuthEnrollmentStatus } from "./oauth-enrollment.js";

test("locked owner can recover without a bearer; origin, password and throttling enforced", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "oauth-recovery-"));
  const db = join(stateDir, "devspace.sqlite");
  await writeFile(db, "existing grants sentinel");
  lockOAuthEnrollment(stateDir);
  const app = express();
  registerOAuthRecovery(app, { stateDir, publicBaseUrl: "https://owner.example", oauth: { ownerToken: "test-owner" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/oauth/recovery`;
  const post = (password: string, origin = "https://owner.example") => fetch(url, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ owner_token: password }) });
  try {
    const page = await fetch(url); assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await post("test-owner", "https://evil.example")).status, 403);
    assert.equal((await post("wrong")).status, 401);
    assert.equal(getOAuthEnrollmentStatus(stateDir).acceptingNewConnections, false);
    const before = Date.now();
    assert.equal((await post("test-owner")).status, 200);
    const state = getOAuthEnrollmentStatus(stateDir); assert.equal(state.locked, true); assert.equal(state.acceptingNewConnections, true);
    assert(state.allowUntilMs! >= before + 900_000);
    assert.equal(getOAuthEnrollmentStatus(stateDir, state.allowUntilMs).acceptingNewConnections, false);
    for (let i = 0; i < 3; i++) assert.equal((await post("wrong")).status, 401);
    assert.equal((await post("test-owner")).status, 429);
    assert.equal(await readFile(db, "utf8"), "existing grants sentinel");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(stateDir, { recursive: true, force: true }); }
});
