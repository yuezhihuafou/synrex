import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const config = subagentsConfigSchema.parse({
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: " gpt-5.4 ", effort: " high " },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.deepEqual(config, {
  enabled: true,
  instructions: "on-demand",
  providers: [
    { id: "codex", enabled: true, model: "gpt-5.4", effort: "high" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");
assert.equal(
  subagentsConfigSchema.parse({ enabled: true, instructions: "preload", providers: [] }).instructions,
  "preload",
);

assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true }, { id: "codex", enabled: false }],
  }),
  /Duplicate subagent provider: codex/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "unknown", enabled: true }],
  }),
  /requires a CLI specification/,
);

const configuredCli = subagentsConfigSchema.parse({
  enabled: true,
  providers: [{
    id: "my-cli", enabled: true,
    cli: { command: "/usr/local/bin/my-agent", args: ["--output-format", "json"], sessionFlag: "--session" },
  }],
});
assert.equal(configuredCli.providers[0]?.cli?.command, "/usr/local/bin/my-agent");
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }),
  /Too small/,
);
