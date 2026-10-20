import assert from "node:assert/strict";
import test from "node:test";
import { devspaceConfigSchema } from "../config-schema.js";
import { hostsDirectory, joinsDirectory } from "./topology.js";

test("new peer topology requires a directory address", () => {
  const invalid = devspaceConfigSchema.safeParse({ configVersion: 1, cluster: { role: "peer" } });
  assert.equal(invalid.success, false);
  const valid = devspaceConfigSchema.parse({
    configVersion: 1,
    cluster: { role: "peer", gatewayUrl: "http://127.0.0.1:7678" },
  });
  assert.equal(valid.cluster.role, "peer");
  assert.equal(joinsDirectory(valid.cluster.role), true);
});

test("coordinator and legacy gateway accept the same registration transport", () => {
  for (const role of ["coordinator", "gateway"] as const) {
    const config = devspaceConfigSchema.parse({ configVersion: 1, cluster: { role } });
    assert.equal(hostsDirectory(config.cluster.role), true);
    assert.equal(config.cluster.gatewayUrl, null);
  }
});

test("legacy worker remains loadable with its previous peer transport", () => {
  const config = devspaceConfigSchema.parse({
    configVersion: 1,
    cluster: { role: "worker", gatewayUrl: "https://devspace.example.org" },
  });
  assert.equal(config.cluster.role, "worker");
  assert.equal(joinsDirectory(config.cluster.role), true);
});
