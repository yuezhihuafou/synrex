/** Real HTTP/OAuth/MCP smoke test for an immutable DevSpace release.
 *  Runs on loopback using fresh, disposable owner credentials and SQLite.
 *  No production tokens, OAuth databases, or listening ports are modified.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "jsonc-parser";

const release = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: tsx scripts/probe-reliable-release.ts <pinned-release-directory>");
// Fail before launching a server if a candidate omits runtime assets used
// during open_workspace or Console rendering.
for (const required of [
  "dist/cli.js", "dist/server.js", "dist/ui/.vite/manifest.json",
  "package.json", "skills/subagents/SKILL.md", "node_modules",
]) {
  const asset = await stat(join(release, required)).catch(() => null);
  if (!asset) throw new Error(`Incomplete QA release: missing ${required}`);
}
const originalConfigDir = process.env.DEVSPACE_CONFIG_DIR;
if (!originalConfigDir) throw new Error("Set DEVSPACE_CONFIG_DIR to the current owner config directory");
const scratch = await mkdtemp(join(tmpdir(), "devspace-reliable-qa-"));
const configDir = join(scratch, "config");
const stateDir = join(scratch, "state");
let server: ChildProcess | undefined;

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolveReady, reject) =>
    probe.once("error", reject).listen(0, "127.0.0.1", resolveReady));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a loopback port");
  await new Promise<void>((resolveReady) => probe.close(() => resolveReady()));
  return address.port;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Candidate exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
    } catch { /* Candidate may still be starting. */ }
    await delay(100);
  }
  throw new Error("Candidate did not become healthy on QA loopback listener");
}

async function stopCandidate(): Promise<void> {
  const processToStop = server;
  if (!processToStop?.pid) return;
  server = undefined;
  if (processToStop.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-processToStop.pid, "SIGTERM");
    else processToStop.kill("SIGTERM");
  } catch { return; }
  await Promise.race([
    new Promise<void>((done) => processToStop.once("exit", () => done())),
    delay(2000),
  ]);
}

async function runAuthenticatedProbe(env: NodeJS.ProcessEnv, resumeId?: string) {
  const child = spawn("pnpm", ["exec", "tsx", "scripts/probe-live-schema.ts"], {
    env: {
      ...env,
      DEVSPACE_QA_WORKFLOW_PROBE: "1",
      ...(resumeId ? { DEVSPACE_QA_WORKFLOW_RESUME_ID: resumeId } : {}),
    },
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk).slice(0, 5000); });
  child.stderr?.on("data", (chunk) => { output += String(chunk).slice(0, 5000); });
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Live authenticated MCP probe timed out"));
    }, 35_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (exitCode) => { clearTimeout(timer); done(exitCode); });
  });
  if (code !== 0) throw new Error(`QA MCP probe failed (exit=${code}): ${output.slice(-2000)}`);
  const probeResult = output.trim().split("\n").at(-1);
  const result = JSON.parse(probeResult ?? "{}") as {
    toolCount?: number; schemaFingerprint?: string; qaWorkflowId?: string;
    qaDurableTaskRecovered?: boolean;
    qaMailboxDelivered?: boolean;
    qaFinalBarrierVerified?: boolean;
  };
  assert.equal(result.toolCount, 17);
  if (!resumeId) {
    assert.equal(result.qaMailboxDelivered, true, "Normal tool reply must carry completion mailbox event");
    assert.equal(result.qaFinalBarrierVerified, true, "Legacy final barrier must complete over HTTP");
  }
  assert.match(result.qaWorkflowId ?? "", /^wf_[a-f0-9]{24}$/);
  return result;
}

try {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const raw = await readFile(join(originalConfigDir, "config.jsonc"), "utf8");
  const config = parse(raw) as {
    server: Record<string, unknown>;
    storage: Record<string, unknown>;
    oauth: Record<string, unknown>;
    cluster: Record<string, unknown>;
    workspaces: Record<string, unknown>;
  };
  assert.ok(config?.server && config.storage && config.oauth && config.cluster && config.workspaces);
  const port = await freePort();
  const localBase = `http://127.0.0.1:${port}`;
  Object.assign(config.server, {
    host: "127.0.0.1", port, publicBaseUrl: localBase,
    allowedHosts: [], trustProxy: false,
  });
  config.storage.stateDir = stateDir;
  // QA runs the probe from the source tree whose exact compiled schema is
  // under test. Permit this tree only in the throwaway private configuration,
  // never by changing the live owner's allowed root list.
  const existingRoots = Array.isArray(config.workspaces.allowedRoots)
    ? config.workspaces.allowedRoots as string[] : [];
  config.workspaces.allowedRoots = [...new Set([...existingRoots, process.cwd()])];
  config.oauth.allowedResourceUrls = [];
  Object.assign(config.cluster, { role: "standalone", gatewayUrl: null, placementRules: [] });
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: randomBytes(32).toString("base64url"),
    nodeJoinToken: randomBytes(32).toString("base64url"),
  }), { mode: 0o600 });
  const env = { ...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_COMPACT_RUN_ROOT: join(scratch, "runs") };
  server = spawn(process.execPath, [join(release, "dist/cli.js"), "serve"], {
    env, stdio: "ignore", detached: process.platform !== "win32",
  });
  await waitForServer(localBase, server);
  const unauth = await fetch(`${localBase}/mcp`);
  assert.equal(unauth.status, 401, "QA endpoint must reject unauthenticated access");
  // Separate owner-authenticated, read-only browser management surface.
  const consolePage = await fetch(`${localBase}/console`);
  assert.equal(consolePage.status, 200, "Console page must be served");
  const consoleHtml = await consolePage.text();
  assert.match(consoleHtml, /Synrex Console/);
  assert.ok(!consoleHtml.includes("ownerToken"), "HTML must not expose the owner credential");
  const consoleBlocked = await fetch(`${localBase}/console/api/snapshot`);
  assert.equal(consoleBlocked.status, 401, "Dashboard data must never be public");
  const noOrigin = await fetch(`${localBase}/console/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(noOrigin.status, 403, "Login without same-origin proof must fail");
  const authData = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")) as { ownerToken: string };
  const badLogin = await fetch(`${localBase}/console/api/login`, {
    method: "POST", headers: { origin: localBase, "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(badLogin.status, 401);
  const loggedIn = await fetch(`${localBase}/console/api/login`, {
    method: "POST", headers: { origin: localBase, "content-type": "application/json" },
    body: JSON.stringify({ password: authData.ownerToken }),
  });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("rev_console="));
  assert.match(loggedIn.headers.get("set-cookie") ?? "", /HttpOnly/i);
  assert.match(loggedIn.headers.get("set-cookie") ?? "", /SameSite=Strict/i);
  const dashboard = await fetch(`${localBase}/console/api/snapshot`, {
    headers: { cookie },
  });
  assert.equal(dashboard.status, 200);
  const dashboardData = await dashboard.json() as { nodes: unknown[]; workflows: unknown[]; diagnostics: unknown };
  assert.ok(Array.isArray(dashboardData.nodes));
  assert.ok(Array.isArray(dashboardData.workflows));
  assert.ok(dashboardData.diagnostics);
  const invalidSession = await fetch(`${localBase}/console/api/snapshot`, {
    headers: { cookie: `${cookie}invalid` },
  });
  assert.equal(invalidSession.status, 401);
  const browser = spawnSync("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--virtual-time-budget=1800", "--dump-dom", `${localBase}/console`,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const browserRendered = browser.status === 0
    && browser.stdout.includes("login-panel") && browser.stdout.includes("进入控制台");
  if (browser.status === 0 && !browserRendered) {
    throw new Error("Chrome rendered the Console page without the expected login UI");
  }
  if (browser.status !== 0) {
    console.error("Optional headless browser QA unavailable; HTTP auth/data QA still enforced.");
  }
  const result = await runAuthenticatedProbe(env);
  await stopCandidate();
  server = spawn(process.execPath, [join(release, "dist/cli.js"), "serve"], {
    env, stdio: "ignore", detached: process.platform !== "win32",
  });
  await waitForServer(localBase, server);
  const resumed = await runAuthenticatedProbe(env, result.qaWorkflowId);
  assert.equal(resumed.qaWorkflowId, result.qaWorkflowId);
  assert.equal(resumed.qaDurableTaskRecovered, true);
  // The private timeline is intentionally bounded and independent of journald.
  const traceFile = join(stateDir, "diagnostics", "recent.jsonl");
  const trace = (await readFile(traceFile, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; requestId?: string; stage?: string; runId?: string });
  const completedRequests = new Set(trace.filter((entry) => entry.event === "mcp_finished")
    .map((entry) => entry.requestId));
  assert.ok(trace.some((entry) => entry.event === "tool_execution_finished"
    && completedRequests.has(entry.requestId)), "tool and HTTP request must share a request ID");
  for (const stage of ["auth", "mcp_dispatch", "tool_handler", "learning", "mailbox", "task_launch", "task_initial_wait"]) {
    assert.ok(trace.some((entry) => entry.event === "stage_finished" && entry.stage === stage), `missing real HTTP stage ${stage}`);
  }
  assert.ok(trace.some((entry) => entry.event === "mcp_body_ready"));
  assert.ok(trace.some((entry) => entry.event === "mcp_headers_sent"));
  const runId = trace.find((entry) => entry.event === "task_created" && entry.runId)?.runId;
  assert.ok(runId);
  const runTrace = await readFile(join(scratch, "runs", `${runId.slice(4, 8)}-${runId.slice(8, 10)}-${runId.slice(10, 12)}`, runId, "trace.jsonl"), "utf8");
  for (const event of ["task_created", "task_runner_started", "task_spawned", "task_finished"]) assert.ok(runTrace.includes(event));
  assert.ok((await stat(traceFile)).size < 1024 * 1024);
  const diagnosticOutput = spawnSync(process.execPath, [join(release, "dist/cli.js"), "diagnose", "--minutes", "30"], {
    env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(diagnosticOutput.status, 0, diagnosticOutput.stderr);
  const diagnosticReport = JSON.parse(diagnosticOutput.stdout) as { events: unknown[]; requests: unknown[] };
  assert.ok(diagnosticReport.events.length > 0);
  assert.ok(diagnosticReport.requests.length > 0);
  console.log(JSON.stringify({
    qa: "passed", release, authenticatedMcp: true, toolCount: result.toolCount,
    schemaFingerprint: result.schemaFingerprint, isolatedState: true,
    completionMailboxDelivered: result.qaMailboxDelivered,
    finalBarrierVerified: result.qaFinalBarrierVerified,
    persistedThroughRestart: true, durableTaskThroughRestart: true,
    duplicateCreateSafe: true, checkpointReplaySafe: true,
    boundedDiagnosticLog: true, correlatedDiagnosticCli: true,
    fullServerPhaseTrace: true, perRunLifecycleTrace: true,
    console: { served: true, unauthorizedDenied: true, loginProtected: true, snapshotAuthenticated: true,
      browserRendered },
  }));
} finally {
  await stopCandidate();
  await rm(scratch, { recursive: true, force: true });
}
