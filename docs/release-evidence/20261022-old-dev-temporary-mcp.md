# Temporary original-Dev MCP comparison endpoint

Date: 2026-10-22. The original-Dev comparison endpoint was brought online,
but **was not yet connected to an independent ChatGPT conversation**.

- Old binary: immutable `20261020-synrex-perf-v1/dist/cli.js`.
- Standalone isolated configuration/state (not production OAuth):
  `/home/swy/services/devspace/bench-old-dev-20261022`.
- Old Dev listens only on `127.0.0.1:8769` and is proxied by an independent
  temporary Cloudflare HTTPS tunnel.
- Public endpoint at inspection:
  `https://brought-salmon-submit-yearly.trycloudflare.com/mcp`.
- Units: `synrex-benchmark-old-dev-https-20261022.service` and
  `synrex-benchmark-old-dev-tunnel-http2-20261022.service`.
- Verified: public `/healthz` 200, OAuth discovery 200, unauthenticated
  `/mcp` 401; primary swy1 `127.0.0.1:7676/healthz` 200.
- No old-Dev GPT engineering tasks were executed merely by starting this
  service. Distinct ChatGPT custom MCP installation/authorization requires
  user-side UI action and a separately checked auth flow. No matched GPT
  performance delta can yet be calculated.
- Quick tunnels have no uptime guarantee. After the benchmark, stop both
  temporary units; do not stop the production `devspace.service`.
