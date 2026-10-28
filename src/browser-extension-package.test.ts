import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserExtensionZip } from "./browser-extension-package.js";

test("browser extension package is generated from the current observer sources", () => {
  const zip = buildBrowserExtensionZip();
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const text = zip.toString("utf8");
  for (const name of ["manifest.json", "background.js", "content.js", "popup.html", "popup.js", "README.md"]) {
    assert.ok(text.includes(name), name);
  }
  assert.ok(text.includes("Synrex Transport Metadata Observer"));
  assert.ok(text.includes('"version": "1.1.1"'));
  assert.ok(!text.includes("devspace.yuezhihuafou.dpdns.org"));
});
