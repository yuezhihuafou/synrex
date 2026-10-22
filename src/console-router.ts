import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { readConsoleSnapshot } from "./console-snapshot.js";
import { DiagnosticTrace } from "./diagnostic-trace.js";
import { readOtelFileTail } from "./otel-file-reader.js";
import { readArchivedTrace, readGatewayArchivedTrace, searchArchive, searchGatewayArchive, historyStats } from "./observability-history.js";
import { assignConversationLabel, readConversationLabels } from "./conversation-labels.js";

const COOKIE_NAME = "rev_console";
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60_000;

function equal(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function createConsoleSession(ownerToken: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const payload = `${expires}.${randomBytes(12).toString("hex")}`;
  return `${payload}.${createHmac("sha256", ownerToken).update("rev-console-v1:" + payload).digest("base64url")}`;
}

export function verifyConsoleSession(value: string | undefined, ownerToken: string, now = Date.now()): boolean {
  if (!value || value.length > 250 || !/^\d{10,12}\.[a-f0-9]{24}\.[a-zA-Z0-9_-]{43}$/.test(value)) return false;
  const [expires, nonce, signature] = value.split(".");
  const end = Number(expires);
  if (!Number.isSafeInteger(end) || end * 1000 <= now || end * 1000 > now + SESSION_SECONDS * 1000) return false;
  const expected = createHmac("sha256", ownerToken)
    .update(`rev-console-v1:${expires}.${nonce}`).digest("base64url");
  return equal(signature!, expected);
}

function readCookie(request: Request): string | undefined {
  const header = request.header("cookie") ?? "";
  if (header.length > 2000) return undefined;
  const cookie = header.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return cookie?.slice(COOKIE_NAME.length + 1);
}

function consoleManifest(): { file: string; css?: string[] } {
  const manifestPath = fileURLToPath(new URL("../dist/ui/.vite/manifest.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, { file: string; css?: string[] }>;
  const entry = manifest["console-app.html"];
  if (!entry?.file) throw new Error("Synrex Console assets missing. Build the full release first.");
  return entry;
}

function serveConsoleHtml(config: ServerConfig): string {
  const entry = consoleManifest();
  const origin = config.publicBaseUrl.replace(/\/+$/, "");
  const base = `${origin}/mcp-app-assets`;
  const resources = [entry.file, ...(entry.css ?? [])];
  if (resources.some((file) => !/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9._-]+$/.test(file))) {
    throw new Error("Invalid console asset path");
  }
  const css = (entry.css ?? []).map((file) => `<link rel="stylesheet" href="${base}/${file}">`).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synrex Console</title>${css}
<script type="module" crossorigin src="${base}/${entry.file}"></script>
</head><body><div id="app"></div></body></html>`;
}

function actualRelease(): string {
  const manifest = path.resolve(fileURLToPath(new URL("../release-manifest.json", import.meta.url)));
  if (!existsSync(manifest)) return "development";
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { release?: string };
    return parsed.release ?? "development";
  } catch { return "development"; }
}

/**
 * Separate browser session from MCP OAuth. No arbitrary command execution or
 * editable data routes. This console intentionally has no access to model host
 * cookies or the OAuth bearer token.
 */
export function registerSynrexConsole(app: Express, config: ServerConfig): void {
  const attempts = new Map<string, { count: number; until: number }>();
  const expectedOrigin = new URL(config.publicBaseUrl).origin;
  const https = expectedOrigin.startsWith("https:");
  const sessionCookieOptions = {
    httpOnly: true, sameSite: "strict" as const, secure: https,
    path: "/console", maxAge: SESSION_SECONDS * 1000,
  };
  const auth = (req: Request, res: Response, next: () => void): void => {
    if (!verifyConsoleSession(readCookie(req), config.oauth.ownerToken)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(401).json({ error: "Login required" });
      return;
    }
    next();
  };
  const sameOrigin = (req: Request): boolean =>
    req.header("origin") === expectedOrigin && req.is("application/json") === "application/json";
  const noStore = (_req: Request, res: Response, next: () => void) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
  app.use("/console", noStore);
  app.get(["/console", "/console/"], (_req, res) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'none'", "script-src 'self'", "style-src 'self'",
      "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
      "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ].join("; "));
    res.type("html").send(serveConsoleHtml(config));
  });
  app.post("/console/api/login", express.json({ limit: "2kb" }), (req, res) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: "Origin rejected" }); return; }
    const remote = req.ip ?? "unknown";
    const now = Date.now();
    const entry = attempts.get(remote);
    if (entry && now < entry.until && entry.count >= MAX_LOGIN_ATTEMPTS) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
      res.status(429).json({ error: "Too many login attempts" });
      return;
    }
    const ownerToken = typeof req.body?.password === "string" ? req.body.password : "";
    if (!equal(ownerToken, config.oauth.ownerToken)) {
      const prior = entry && now < entry.until ? entry.count : 0;
      if (attempts.size > 2000) attempts.clear();
      attempts.set(remote, { count: prior + 1, until: now + LOGIN_WINDOW_MS });
      res.status(401).json({ error: "Invalid owner password" });
      return;
    }
    attempts.delete(remote);
    res.cookie(COOKIE_NAME, createConsoleSession(config.oauth.ownerToken), sessionCookieOptions);
    res.status(200).json({ authenticated: true });
  });
  app.get("/console/api/session", auth, (_req, res) => {
    res.json({ authenticated: true });
  });
  app.get("/console/api/browser-extension", auth, (_req, res) => {
    const archive = fileURLToPath(new URL("../deploy/observability/browser-extension.zip",import.meta.url));
    if(!existsSync(archive)){res.status(404).json({error:"Extension package unavailable"});return;}
    res.download(archive,"synrex-browser-observer.zip");
  });
  app.post("/console/api/logout", (req, res) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: "Origin rejected" }); return; }
    res.clearCookie(COOKIE_NAME, sessionCookieOptions);
    res.json({ authenticated: false });
  });
  app.get("/console/api/snapshot", auth, (_req, res) => {
    try {
      res.json(readConsoleSnapshot(config.stateDir, actualRelease()));
    } catch {
      res.status(503).json({ error: "Status data temporarily unavailable" });
    }
  });
  app.get("/console/api/history", auth, async (req, res) => {
    try {
      const start=typeof req.query.start==="string"?req.query.start:undefined;
      const end=typeof req.query.end==="string"?req.query.end:undefined;
      const event=typeof req.query.event==="string"?req.query.event:undefined;
      const local=searchArchive(config.stateDir,{start,end,event});
      const remote=await searchGatewayArchive({start,end,event});
      const events=[...local,...remote.events].sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,500);
      const ownerLabels = new Map(readConversationLabels(config.stateDir,
        events.map(e=>e.requestId).filter((s):s is string=>Boolean(s)))
        .map(label=>[label.requestId,label]));
      res.json({events:events.map(e=>({...e,
        ...(e.requestId && ownerLabels.has(e.requestId)
          ? {conversationTitle:ownerLabels.get(e.requestId)!.conversationTitle}:{}),
      })),stats:historyStats(config.stateDir),retentionDays:7,
        gatewayHistory:remote.available?"available":"unavailable"});
    } catch {res.status(503).json({error:"Archive temporarily unavailable"});}
  });
  app.get("/console/api/trace", auth, async (req, res) => {
    const requestId = req.query.requestId;
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,110}$/.test(requestId)) {
      res.status(400).json({ error: "Invalid request ID" });
      return;
    }
    try {
      const recent = new DiagnosticTrace(config.stateDir).read({ minutes: 24 * 60, limit: 20_000, requestId });
      const localHistory=readArchivedTrace(config.stateDir,requestId);
      const peerKey=localHistory.events.find(e=>e.otelTraceId)?.otelTraceId ?? requestId;
      const peerHistory=await readGatewayArchivedTrace(peerKey);
      const relatedNodeRequestIds=new Set(localHistory.events.map(e=>e.nodeRequestId).filter(Boolean));
      const linkedPeerEvents=peerHistory.events.filter(e=>e.nodeRequestId && relatedNodeRequestIds.has(e.nodeRequestId));
      const linkedPeerRequestIds=new Set(linkedPeerEvents.map(e=>e.requestId).filter(Boolean));
      const archived = [
        ...[...localHistory.events,...readOtelFileTail(config.stateDir).logs].filter(e=>
          e.requestId === requestId || e.traceId === requestId || e.nodeRequestId === requestId),
        ...linkedPeerEvents,
      ];
      const found = new Map([...archived, ...recent].map(e => [
        [e.ts,e.event,e.requestId,e.callId,e.stage,e.nodeRequestId].join("|"), e,
      ]));
      const all = [...found.values()].sort((a, b) => a.ts.localeCompare(b.ts));
      const allSpans=[...localHistory.spans,...peerHistory.spans.filter(s=>
        s.requestId && linkedPeerRequestIds.has(s.requestId))];
      const uniqueSpans=[...new Map(allSpans.map(s=>[s.traceId+":"+s.spanId,s])).values()];
      const ownerLabel=readConversationLabels(config.stateDir,[requestId])[0];
      const hostLabel=all.find(e=>e.event==="conversation_labeled" && e.conversationTitle)?.conversationTitle;
      res.json({ requestId, conversationTitle:ownerLabel?.conversationTitle??hostLabel??null,
        titleSource:ownerLabel?"owner":hostLabel?"host":"unknown",
        events: all.slice(-1000), spans:uniqueSpans.slice(-1000),
        truncated: all.length > 1000 || uniqueSpans.length>1000,
        archiveCoverage: historyStats(config.stateDir).events ? "indexed_7d" : "bounded_tail",
        remoteState:peerHistory.remoteState,
        remoteTraceGroupExcluded:peerHistory.spans.length-allSpans.length+localHistory.spans.length,
        hostInternalStages: "not_observed" });
    } catch {
      res.status(503).json({ error: "Trace temporarily unavailable" });
    }
  });
  app.post("/console/api/conversation-label", auth, express.json({limit:"2kb"}), (req,res)=>{
    if (!sameOrigin(req)) {res.status(403).json({error:"Origin rejected"});return;}
    try {
      const id=req.body?.requestId;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,110}$/.test(id)) {
        res.status(400).json({error:"Invalid request ID"});return;
      }
      const inRecent=new DiagnosticTrace(config.stateDir).read({minutes:1440,limit:20000,requestId:id}).length>0;
      const archived=readArchivedTrace(config.stateDir,id).events.length>0;
      if (!inRecent && !archived) {
        res.status(404).json({error:"Cannot label an unobserved request"});return;
      }
      const label=assignConversationLabel(config.stateDir,id,req.body?.conversationTitle);
      new DiagnosticTrace(config.stateDir).record("conversation_labeled", {
        requestId:id,conversationTitle:label.conversationTitle,
      });
      res.status(200).json({label});
    } catch {
      res.status(400).json({error:"Invalid label"});
    }
  });
}
