import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("first-install helper does not overwrite an existing user service", () => {
  const root = mkdtempSync(join(tmpdir(), "synrex-install-guard-"));
  try {
    const config = join(root, "config");
    const units = join(config, "systemd", "user");
    mkdirSync(units, { recursive: true });
    const service = join(units, "devspace.service");
    const original = "[Service]\nExecStart=/pinned/release/cli.js\n";
    writeFileSync(service, original);

    const result = spawnSync("bash", [resolve("deploy/install-user-service.sh")], {
      cwd: resolve("."),
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: config, NODE_BIN: "/no-such-node" },
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 75);
    assert.match(result.stderr, /INSTALL_BLOCKED/);
    assert.equal(readFileSync(service, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
