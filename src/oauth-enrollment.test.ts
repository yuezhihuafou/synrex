import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  getOAuthEnrollmentStatus,
  usePasswordOnlyEnrollment,
  closeOAuthEnrollmentAfterGrant,
  recordOAuthEnrollmentGrant,
  lockOAuthEnrollment,
  oauthEnrollmentAllowed,
  openOAuthEnrollmentWindow,
} from "./oauth-enrollment.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { setDevspaceConfigValue } from "./user-config.js";

const execFileAsync = promisify(execFile);

test("OAuth enrollment policy persists, expires, and fails closed if corrupt", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-enrollment-policy-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));

  assert.equal(oauthEnrollmentAllowed(stateDir), true, "legacy installs are not implicitly broken");
  assert.deepEqual(getOAuthEnrollmentStatus(stateDir), {
    locked: false, acceptingNewConnections: true,
  });
  assert.throws(() => openOAuthEnrollmentWindow(stateDir, 5), /Lock OAuth enrollment first/);

  lockOAuthEnrollment(stateDir);
  const policyPath = join(stateDir, "oauth-enrollment.json");
  const locked = JSON.parse(await readFile(policyPath, "utf8")) as { locked: boolean; allowUntilMs: number };
  assert.deepEqual(locked, { locked: true, allowUntilMs: 0 });
  assert.equal(oauthEnrollmentAllowed(stateDir), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(policyPath)).mode & 0o777, 0o600);
  }

  for (const minutes of [0, -1, 1.5, 16, Number.NaN]) {
    assert.throws(() => openOAuthEnrollmentWindow(stateDir, minutes), /1-15 minutes/);
  }
  const anchorMs = 1_800_000_000_000;
  const expiration = openOAuthEnrollmentWindow(stateDir, 5, anchorMs);
  assert.equal(expiration, anchorMs + 300_000);
  assert.equal(oauthEnrollmentAllowed(stateDir, expiration - 1), true);
  assert.equal(oauthEnrollmentAllowed(stateDir, expiration), false);
  lockOAuthEnrollment(stateDir);
  assert.equal(oauthEnrollmentAllowed(stateDir, anchorMs), false);

  await writeFile(policyPath, "{ broken JSON");
  assert.equal(oauthEnrollmentAllowed(stateDir), false, "malformed state fails closed");
  lockOAuthEnrollment(stateDir);
  assert.equal(oauthEnrollmentAllowed(stateDir), false);
});

test("locked enrollment denies new OAuth registrations and grants without revoking active sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-enrollment-server-"));
  const stateDir = join(root, "state");
  const publicBaseUrl = "https://owner.example.test";
  const resource = `${publicBaseUrl}/mcp`;
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const ownerToken = "owner-token-for-enrollment-integration";
  const verifier = "enrollment-integration-verifier-01234567890123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const configEnv = writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl },
    storage: { stateDir },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent" },
  });
  const config = loadConfig(configEnv);
  const running = createServer({ ...config, oauth: { ...config.oauth, ownerToken } });
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const registrationBody = JSON.stringify({
    client_name: "owner-chatgpt",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const register = () => fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: registrationBody,
  });
  const registered = await register();
  assert.equal(registered.status, 201, await registered.clone().text());
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const authorizationParams = () => new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256",
    scope: "devspace", resource, state: "enrollment-state", owner_token: ownerToken,
  });
  const authorize = () => fetch(`${base}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationParams(),
  });

  const approved = await authorize();
  assert.equal(approved.status, 302, await approved.clone().text());
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code);
  const exchange = (authorizationCode: string) => fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code: authorizationCode,
      code_verifier: verifier, redirect_uri: redirectUri, resource,
    }),
  });
  const exchanged = await exchange(code);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const issued = await exchanged.json() as { access_token: string; refresh_token: string };

  lockOAuthEnrollment(stateDir);
  assert.equal((await register()).status >= 400, true, "new client registration is denied");
  const reapproved = await authorize();
  assert.equal(reapproved.status, 302, "already registered Owner client can reauthorize while enrollment is locked");
  const reapprovedCode = new URL(reapproved.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(reapprovedCode);
  const reapprovedTokens = await exchange(reapprovedCode);
  assert.equal(reapprovedTokens.status, 200, "locked enrollment cannot interrupt an approved code exchange");

  const active = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${issued.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  assert.equal(active.status, 200, await active.clone().text());

  const refresh = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: issued.refresh_token, resource,
    }),
  });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const rotated = await refresh.json() as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, issued.refresh_token);

  openOAuthEnrollmentWindow(stateDir, 1);
  assert.equal((await register()).status, 201, "owner can temporarily enroll another OAuth client");
  const pending = await authorize();
  assert.equal(pending.status, 302, await pending.clone().text());
  const pendingCode = new URL(pending.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(pendingCode);
  lockOAuthEnrollment(stateDir);
  const completedExchange = await exchange(pendingCode);
  assert.equal(completedExchange.status, 200,
    "an Owner-approved, short-lived code can complete despite a window closing");
  const reusedCode = await exchange(pendingCode);
  assert.equal(reusedCode.status >= 400, true, "code is still single-use after re-locking");

  const rotatedRefresh = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId,
      refresh_token: rotated.refresh_token, resource,
    }),
  });
  assert.equal(rotatedRefresh.status, 200, await rotatedRefresh.clone().text());

  // The deployment probe must respect lockdown without creating a synthetic
  // production OAuth client or touching the token database.
  setDevspaceConfigValue(["server", "port"], address.port, configEnv);
  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx", "scripts/probe-live-schema.ts",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...configEnv },
    timeout: 20_000,
  });
  const report = JSON.parse(stdout.trim()) as {
    ok: boolean; verification: string; liveAuthenticatedToolListVerified: boolean;
  };
  assert.equal(report.ok, true);
  assert.equal(report.verification, "locked-http-and-compiled-schema");
  assert.equal(report.liveAuthenticatedToolListVerified, false);
});

test("password-only policy persists without a timer and overrides an expired lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-password-only-"));
  try {
    lockOAuthEnrollment(dir);
    usePasswordOnlyEnrollment(dir);
    assert.deepEqual(getOAuthEnrollmentStatus(dir, Date.now() + 365 * 86400000), {
      locked: false, acceptingNewConnections: true,
    });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "oauth-enrollment.json"), "utf8")), {
      locked: false, allowUntilMs: 0,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("single-grant admin window closes after a grant without touching ordinary windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-one-grant-"));
  try {
    lockOAuthEnrollment(dir);
    openOAuthEnrollmentWindow(dir, 10, Date.now(), { closeAfterGrant: true });
    assert.equal(oauthEnrollmentAllowed(dir), true);
    recordOAuthEnrollmentGrant(dir, "new-grant-hash");
    assert.equal(oauthEnrollmentAllowed(dir), true, "lost token responses can be retried through a new authorization");
    assert.equal(closeOAuthEnrollmentAfterGrant(dir, "old-client-hash"), false);
    assert.equal(closeOAuthEnrollmentAfterGrant(dir, "new-grant-hash"), true);
    assert.equal(oauthEnrollmentAllowed(dir), false);
    assert.equal(closeOAuthEnrollmentAfterGrant(dir, "new-grant-hash"), false);
    openOAuthEnrollmentWindow(dir, 10);
    assert.equal(closeOAuthEnrollmentAfterGrant(dir, "new-grant-hash"), false);
    assert.equal(oauthEnrollmentAllowed(dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
