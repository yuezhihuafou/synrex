import assert from "node:assert/strict";
import test from "node:test";
import { oauthPhaseForPath, requestPath } from "./logger.js";

test("request logging preserves OAuth paths through nested Express routers", () => {
  const request = {
    originalUrl: "/token?grant_type=refresh_token",
    url: "/",
    path: "/",
  } as never;
  assert.equal(requestPath(request), "/token");
  assert.equal(oauthPhaseForPath("/token"), "token");
  assert.equal(oauthPhaseForPath("/authorize"), "authorize");
  assert.equal(oauthPhaseForPath("/.well-known/oauth-authorization-server"), "discovery");
});
