import assert from "node:assert/strict";
import { test } from "node:test";
import { displayedNodeHealth } from "./node-status.js";

test("local displayed state comes from fresh console sample, not old registration", () => {
  const now = Date.parse("2026-10-22T10:30:00.000Z");
  const local = { kind: "local", health: "online" };
  assert.equal(displayedNodeHealth(local, new Date(now - 1000).toISOString(), new Date(now - 8_000_000).toISOString(), now), "online");
  assert.equal(displayedNodeHealth(local, new Date(now - 21_000).toISOString(), new Date(now - 8_000_000).toISOString(), now), "unconfirmed");
  assert.equal(displayedNodeHealth(local, undefined, undefined, now), "unconfirmed");
});

test("remote directory health is valid only with a fresh console and directory", () => {
  const now = Date.parse("2026-10-22T10:30:00.000Z");
  const recent = new Date(now - 2_000).toISOString();
  assert.equal(displayedNodeHealth({ kind: "remote", health: "offline" }, recent, recent, now), "offline");
  assert.equal(displayedNodeHealth({ kind: "remote", health: "online" }, recent, new Date(now - 46_000).toISOString(), now), "unconfirmed");
  assert.equal(displayedNodeHealth({ kind: "remote", health: "online" }, new Date(now + 20_000).toISOString(), recent, now), "unconfirmed");
});
