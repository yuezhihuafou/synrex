import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationMetadataPath,
  normalizedPublicBasePath,
  publicEndpointUrl,
} from "./public-endpoints.js";

test("public endpoints preserve an optional public base path", () => {
  assert.equal(normalizedPublicBasePath("https://dev.example.test"), "");
  assert.equal(normalizedPublicBasePath("https://dev.example.test/"), "");
  assert.equal(normalizedPublicBasePath("https://dev.example.test/group/"), "/group");
  assert.equal(publicEndpointUrl("https://dev.example.test/group", "/mcp").href, "https://dev.example.test/group/mcp");
  assert.equal(publicEndpointUrl("https://dev.example.test/group/", "token").href, "https://dev.example.test/group/token");
  assert.equal(authorizationMetadataPath("https://dev.example.test/group"), "/.well-known/oauth-authorization-server/group");
});
