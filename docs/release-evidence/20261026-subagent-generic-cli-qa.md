# Subagent Generic CLI + AGY continuation — verified QA

Date: 2026-10-26. Source baseline: `e4da7974964a49fb468a8106fbb885e354dd0e1a`.

Scope: Generic headless CLI provider contract, declarative AGY integration,
per-agent durable AGY session state, structured live events and aggregate usage.
MCP production/OAuth state was not modified or switched during development.

## Verification

- `pnpm exec tsc -p tsconfig.json --noEmit`: passed.
- `pnpm build`: passed.
- Focused AGY, generic CLI, RuntimePool, Manager, Daemon, persistence,
  configuration and protocol checks: passed.
- The real installed AGY binary returned `conversation_id`, incremental
  `step_update` and final reported token usage in `stream-json` mode.
- Real Synrex CLI + independent QA config + systemd Daemon:
  `agents run antigravity` returned `agt_7e7fe990` and `ACK`;
  `agents continue agt_7e7fe990` returned the previous-turn phrase
  `COPPER_LANTERN_904`;
  `agents show`, `agents events`, and `agents stats` returned consistent
  records and measured usage. A further `continue` after Daemon restart
  returned the same phrase using the saved 36-character provider session ID.
- Control test: temporary per-turn AGY home failed to continue, while the
  new durable per-agent private CLI home succeeded.
- A deliberate QA call using `DEVSPACE_AGENTD_LAUNCHER=detached` was terminated
  by the command-runner process lifetime; repeating with supported systemd
  Daemon activation passed. This failure is retained in aggregate QA stats.

## Boundaries

- This change unifies command launching and stream parsing for declarative
  headless CLIs. Existing native SDK / ACP adapters are retained unchanged.
- Agent events are persisted and exposed for bounded polling (`agents watch`
  polls at 500 ms); no claim of a push stream to ChatGPT or Console UI.
- Token counts use provider-reported values, never inferred values. Missing
  metrics remain `null`.
- Per-agent private AGY homes retain CLI session state and copied
  authentication data in owner-only directories. Retired states need cleanup.
- A broad test run had an unrelated `local-agent-pi-sandbox.test.ts` failure
  because this host cannot grant nested user-namespace CAP_SYS_ADMIN. No Pi
  runtime or sandbox privilege was changed for this feature.
