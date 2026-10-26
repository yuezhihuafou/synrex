import assert from "node:assert/strict";
import test from "node:test";
import { resolveCoreListenPort } from "./server-bind.js";

test("preserves configured production port unless explicitly relocated", () => {
  assert.equal(resolveCoreListenPort(7676, "127.0.0.1", "https://synrex.example.com", undefined), 7676);
  assert.equal(resolveCoreListenPort(7676, "127.0.0.1", "https://synrex.example.com", ""), 7676);
});

test("uses a private alternate listener without changing public issuer", () => {
  assert.equal(resolveCoreListenPort(7676, "127.0.0.1", "https://synrex.example.com", "7677"), 7677);
  assert.equal(resolveCoreListenPort(7676, "::1", "https://synrex.example.com", "8785"), 8785);
});

test("rejects malformed port and unsafe bind", () => {
  for (const value of ["0", "65536", "80", "8.8", " 7677", "-1", "7677;rm", "999999"]) {
    assert.throws(() => resolveCoreListenPort(7676, "127.0.0.1", "https://synrex.example.com", value));
  }
  assert.throws(() => resolveCoreListenPort(7676, "0.0.0.0", "https://synrex.example.com", "7677"));
  assert.throws(() => resolveCoreListenPort(7676, "127.0.0.1", "http://127.0.0.1:7676", "7677"));
});
