import express from "express";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { createConsoleSession, verifyConsoleSession } from "../console-router.js";
import { MonitorCollector } from "./collector.js";

export interface MonitorServerOptions { collector: MonitorCollector; password: string; publicOrigin: string; additionalOrigins?: string[]; assets: string }
const COOKIE = "synrex_monitor";
export function createMonitorApp(options: MonitorServerOptions) {
  const { collector } = options;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); next(); });
  app.use(express.json({ limit: "2kb" }));
  const allowedOrigin = new URL(options.publicOrigin).origin;
  const allowedOrigins = new Set([allowedOrigin, ...(options.additionalOrigins ?? []).map(x => new URL(x).origin)]);
  const cookieOptions = { httpOnly: true, secure: allowedOrigin.startsWith("https:"), sameSite: "strict" as const, path: "/", maxAge: 8 * 3600_000 };
  const auth = (req: Request, res: Response, next: () => void) => {
    const cookie = (req.header("cookie") ?? "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    if (!verifyConsoleSession(cookie, options.password)) { res.status(401).json({ error: "Login required" }); return; }
    next();
  };
  const origin = (req: Request, res: Response, next: () => void) => {
    if (!allowedOrigins.has(req.header("origin") ?? "") || !req.is("application/json")) { res.status(403).json({ error: "Origin rejected" }); return; }
    next();
  };
  let attempts = 0, reset = Date.now();
  app.get("/health", (_req, res) => res.json({ status: "ok", component: "independent-console" }));
  app.post("/console/api/login", origin, (req, res) => {
    if (Date.now() - reset > 60_000) { attempts = 0; reset = Date.now(); }
    if (++attempts > 10) { res.status(429).json({ error: "Try again later" }); return; }
    const input = Buffer.from(typeof req.body?.password === "string" ? req.body.password : ""), expected = Buffer.from(options.password);
    if (input.length !== expected.length || !timingSafeEqual(input, expected)) { res.status(401).json({ error: "Invalid password" }); return; }
    attempts = 0;
    res.cookie(COOKIE, createConsoleSession(options.password), { ...cookieOptions, secure: req.header("origin")!.startsWith("https:") }).json({ authenticated: true });
  });
  app.post("/console/api/logout", origin, (req, res) => res.clearCookie(COOKIE, { ...cookieOptions, secure: req.header("origin")!.startsWith("https:") }).json({ authenticated: false }));
  app.use("/console/api", auth);
  app.get("/console/api/snapshot", async (_req, res) => {
    if (!collector.snapshot.sampledAt || Date.now() - Date.parse(collector.snapshot.sampledAt) > 5000) await collector.sample();
    res.json(collector.snapshot);
  });
  let clients = 0;
  app.get("/console/api/events", (req, res) => {
    if (clients >= 4) { res.status(429).end(); return; }
    clients++;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    let blocked = false, closed = false, first = true;
    let previousRuns = new Map<string, string>(), previousBase = "";
    const send = () => {
      if (blocked || closed) return;
      const snapshot = collector.snapshot;
      const rows = new Map(snapshot.executions.map(row => [row.runId, JSON.stringify(row)]));
      if (first) {
        blocked = !res.write(`event: snapshot\nid: ${snapshot.sampledAt}\ndata: ${JSON.stringify(snapshot)}\n\n`);
        first = false;
      } else {
        const { executions, base, ...common } = snapshot;
        const changed = executions.filter(row => rows.get(row.runId) !== previousRuns.get(row.runId));
        const removed = [...previousRuns.keys()].filter(id => !rows.has(id));
        const body = { ...common, changed, removed, ...(base?.generatedAt !== previousBase ? { base } : {}) };
        blocked = !res.write(`event: patch\nid: ${snapshot.sampledAt}\ndata: ${JSON.stringify(body)}\n\n`);
      }
      previousRuns = rows; previousBase = snapshot.base?.generatedAt ?? "";
    };
    res.on("drain", () => { blocked = false; });
    const unsubscribe = collector.subscribe();
    collector.on("snapshot", send);
    send();
    const heartbeat = setInterval(() => { if (!blocked) blocked = !res.write(": heartbeat\n\n"); }, 15_000);
    const expiry = setTimeout(() => res.end(), 30 * 60_000); // Periodically reauthenticate long streams.
    const cleanup = () => {
      if (closed) return;
      closed = true; clients--; unsubscribe(); collector.off("snapshot", send); clearInterval(heartbeat); clearTimeout(expiry);
    };
    res.on("close", cleanup); req.on("aborted", cleanup);
  });
  app.get("/console/api/output/:run", async (req, res) => {
    try { res.json(await collector.runs.output(String(req.params.run))); }
    catch { res.status(404).json({ error: "Output unavailable" }); }
  });
  app.post("/console/api/cancel/:run", origin, async (req, res) => {
    const run = String(req.params.run), key = req.header("Idempotency-Key");
    if (!key || !/^[a-zA-Z0-9-]{8,80}$/.test(key)) { res.status(400).json({ error: "Idempotency key required" }); return; }
    const old = collector.stats.db.prepare("select target,status from receipts where id=?").get(key) as { target: string; status: string } | undefined;
    if (old) { res.status(old.target === run ? 200 : 409).json({ receipt: key, status: old.status, target: old.target }); return; }
    collector.stats.receipt(key, "cancel", run, "dispatching");
    try {
      const result = await collector.runs.cancel(run);
      collector.stats.db.prepare("update receipts set status=? where id=?").run(result.status, key);
      res.json({ receipt: key, ...result });
    } catch (error) {
      collector.stats.db.prepare("update receipts set status='rejected_or_unconfirmed' where id=?").run(key);
      res.status(409).json({ receipt: key, error: error instanceof Error ? error.message : "Action not confirmed" });
    }
  });
  app.get("/console/api/statistics", (req, res) => {
    const minutes = Number(req.query.minutes ?? 60);
    if (!Number.isFinite(minutes)) { res.status(400).json({ error: "Invalid window" }); return; }
    res.json(collector.stats.query({ minutes, tool: typeof req.query.tool === "string" ? req.query.tool : undefined, workspace: typeof req.query.workspace === "string" ? req.query.workspace : undefined }));
  });
  app.get("/console/api/diagnostics", (req, res) => {
    res.json({ events: collector.stats.events(String(req.query.q ?? "").slice(0, 120), String(req.query.request ?? "").slice(0, 120)), receipts: collector.stats.receipts() });
  });
  app.get("/console/api/trace/:request", (req, res) => {
    try { res.json(collector.stats.trace(String(req.params.request))); }
    catch { res.status(400).json({ error: "Invalid request ID" }); }
  });
  app.get("/console/api/export", (_req, res) => {
    res.attachment("synrex-diagnostics.json").json({ exportedAt: new Date().toISOString(), node: collector.snapshot.source, events: collector.stats.events(), receipts: collector.stats.receipts(), warnings: collector.snapshot.warnings });
  });
  app.get("/", (_req, res) => res.redirect("/console/"));
  app.use("/console", (_req, res, next) => { res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"); next(); }, express.static(options.assets, { index: "monitor-app.html", dotfiles: "deny" }));
  app.use((error: unknown, _req: Request, res: Response, _next: () => void) => { if (!res.headersSent) res.status(500).json({ error: "Console operation unavailable" }); });
  return app;
}
