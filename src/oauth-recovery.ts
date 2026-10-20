import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { getOAuthEnrollmentStatus, openOAuthEnrollmentWindow } from "./oauth-enrollment.js";

/** Independent of MCP bearer sessions, so a locked-out owner can enroll a phone. */
export function registerOAuthRecovery(app: Express, config: {
  stateDir: string; publicBaseUrl: string; oauth: { ownerToken: string };
}): void {
  const origin = new URL(config.publicBaseUrl).origin;
  app.use(["/authorize", "/register", "/token"], (_req, res, next) => {
    res.set({ "Cache-Control": "no-store, max-age=0", "Pragma": "no-cache", "Expires": "0" });
    next();
  });
  let attempts = 0;
  let resetAt = 0;
  app.use("/oauth/recovery", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff" });
    next();
  });
  app.get("/oauth/recovery", (_req, res) => {
    if (!getOAuthEnrollmentStatus(config.stateDir).locked) {
      res.type("html").send('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synrex</title><h1>直接连接 Synrex</h1><p>连接窗口限制已关闭，无需解锁。请回到连接设置，填写 MCP 地址并输入 Owner password：</p><code>' + origin + '/mcp</code></html>');
      return;
    }
    res.type("html").send(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synrex OAuth 恢复</title><h1>开启手机连接窗口</h1><p>输入 Owner password，开启 15 分钟 OAuth 连接窗口。已有授权保持有效。</p><form method="post" action="/oauth/recovery"><label>Owner password <input name="owner_token" type="password" autocomplete="current-password" required></label><button type="submit">开启 15 分钟窗口</button></form></html>`);
  });
  app.post("/oauth/recovery", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
    if (req.get("origin") !== origin) { res.status(403).send("Cross-origin submission denied."); return; }
    const now = Date.now();
    if (now >= resetAt) { attempts = 0; resetAt = now + 60_000; }
    if (++attempts > 5) { res.set("Retry-After", String(Math.ceil((resetAt - now) / 1000))).status(429).send("Too many attempts. Retry in one minute."); return; }
    const provided = typeof req.body?.owner_token === "string" ? req.body.owner_token : "";
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(digest(provided), digest(config.oauth.ownerToken))) {
      res.status(401).send("Owner password was not accepted."); return;
    }
    if (!getOAuthEnrollmentStatus(config.stateDir).locked) {
      res.status(200).send("Password-gated OAuth is ready; no enrollment window is required.");
      return;
    }
    const until = openOAuthEnrollmentWindow(config.stateDir, 15);
    res.type("html").send(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synrex OAuth</title><h1>连接窗口已开启</h1><p>有效期至北京时间 ${new Date(until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}，届时自动关闭。已有授权继续有效。</p><p>请回到手机连接设置，填写 MCP 地址：</p><code>${origin}/mcp</code></html>`);
  });
}
