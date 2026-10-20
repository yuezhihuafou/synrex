import assert from "node:assert/strict";
import test from "node:test";
import { hostsDirectory, joinsDirectory, topologyDescription, topologyRole } from "./topology.js";
import { compareToolContracts } from "./protocol.js";

test("legacy roles preserve the same control-plane behavior", () => {
  assert.equal(topologyRole("gateway"), "coordinator");
  assert.equal(topologyRole("worker"), "peer");
  assert.equal(hostsDirectory("gateway"), true);
  assert.equal(hostsDirectory("coordinator"), true);
  assert.equal(joinsDirectory("worker"), true);
  assert.equal(joinsDirectory("peer"), true);
  assert.equal(hostsDirectory("peer"), false);
  assert.equal(joinsDirectory("coordinator"), false);
});

test("version skew is assessed by actual tool contracts, not git equality", () => {
  assert.deepEqual(compareToolContracts(
    { read: 1, exec_command: 1, research_harness: 1 },
    { read: 1, exec_command: 1, semantic_code: 2 },
  ), { comparable: true, matching: 2, missing: 1, incompatible: 0, total: 3 });
  assert.equal(compareToolContracts(undefined, { read: 1 }).comparable, false);
});

test("local execution exists in every role; directory participation is optional", () => {
  assert.equal(hostsDirectory("standalone"), false);
  assert.equal(joinsDirectory("standalone"), false);
  assert.match(topologyDescription("peer"), /full local execution/);
  assert.match(topologyDescription("coordinator"), /full local execution/);
});
