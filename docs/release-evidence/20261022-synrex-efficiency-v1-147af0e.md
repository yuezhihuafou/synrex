# Synrex V1 efficiency slice: production evidence

- Source commit: `147af0ee9ff80225649ec17e9653b5ce9077b6e1`, built clean.
- Pinned owner release: `20261022-synrex-efficiency-v1-147af0e`.
- Actual scope: batch `read` with single-file fallback for an older peer;
  explicit focused/final verification runner; leaner GPT tool guidance.
- Full verification: 301 passed, 0 failed, 1 skipped (302 total);
  typecheck and architecture conformance passed. Focused integration: 48 passed.
- Production package: 431 compiled `dist` files; dist SHA-256
  `9c7261d9a0603fe2ad` (prefix; full SHA in release manifest).
- Isolated authenticated MCP QA: passed, 17 tools, schema fingerprint
  `681793d91e0578d7e274`; isolated OAuth/SQLite, Console, durable restart,
  completion mailbox, final barrier and checkpoint recovery passed.
- Owner-state backup: `backups/efficiency-20261022/owner-20261021T164537458691Z`.
- Activation: systemd unit `synrex-efficiency-v1-owner-switch.service`;
  `OWNER_RELEASE_ACTIVATED`. swy1 running pinned candidate, health response
  `{"ok":true,"name":"devspace"}`, NRestarts=0; owner SQLite quick_check=ok.
- Nodes: gateway online and its existing independent service active; Windows
  offline. Gateway was not restarted for this backward-compatible protocol
  extension. Old owner release and switch drop-in backup retained for rollback.

This verifies execution and functional compatibility, **not** a measured
end-to-end GPT speed improvement. Real controlled A/B work and additional
repeated-decision reduction remain future phases. Ordinary ChatGPT clients
may need to refresh their tool snapshot to discover the new `read.files` field.
