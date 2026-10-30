# Console Token metrics — measurement contract (P012)

Scope: **Rex-observed MCP tool arguments and text results**, encoded with `o200k_base`. None of these numbers are OpenAI/GPT model usage, hidden reasoning tokens, or model decoder speed. No extra model/API calls occur.

| Visible metric | Calculation | Time/coverage basis |
| --- | --- | --- |
| Last 60s delivery | Completed output Token count in past 60s / 60 | Wall clock; idle time included; no sample means unknown |
| **Runtime average delivery** | Sum of paired output Tokens / sum of *their own* completed MCP HTTP durations in seconds | Work-duration weighted; idle time **between** calls excluded; concurrent calls count separately; may include network/tool latency |
| **Host-session-associated active delivery (24h)** | Sum of measured outputs tied to a host session marker / sum of union-of-HTTP-request intervals per conversation | Conservative association, NOT verified GPT ownership; unknown sessions excluded. Concurrent tool time counted once per conversation |
| **Global host-associated active delivery (24h)** | Sum of host-session-associated output / union of all matching HTTP intervals | Shows concurrent Rex delivery, distinct from the per-session efficiency; does not measure native model tokens |
| **Per-conversation active delivery (24h)** | For each distinct host conversation ID separately: its completed output text tokens / union of its own overlapping HTTP intervals | Display each conversation as its own row with sample count and active seconds. Do **not** show the cross-conversation aggregate as a model or typical conversation rate |
| Attribution coverage | Host-associated complete matches / all completed Token+HTTP matches in last 24h | Missing / unknown sessions do not count as host-associated; no extrapolation |
| Selected-period runtime average | The same ratio using calls attributed to the last 24h / 30d / 365d buckets | Excludes unmatched calls; correct weighting, never average the individual Token/s ratios |
| Peak minute delivery | Largest measured completed output in a minute / 60 | Output attributed to the time it is recorded; not native streaming speed or a sustained model rate |
| Largest tool output | Maximum measured tool-result text tokens | Single completed text response; non-text and oversized outputs omitted |
| Persisted totals | Sum of observed input/output samples | May predate runtime-duration metering; historical missing samples cannot be recovered |

## Data collection and persistence

1. Core logs only bounded numeric lifecycle and Token-worker measurement events. The Worker runs BPE off the MCP event loop, with a 256 KiB payload cap and 16 outstanding jobs; overload is deliberately unmeasured. It never makes AI calls or writes request text.
2. Existing `synrex-console-snapshot.timer` collects every 15s in a **separate short-lived process**. No extra daemon, database, HTTP endpoint, per-conversation model context, or live HTTP aggregation.
3. `observability/token-history.json` contains atomic incremental counters, minute/hour/day buckets, historical peaks, sampled HTTP runtime duration sums, and bounded request ID correlation state. A single disk file is the source of truth for Console history.
4. Keep minute buckets for 24h, hour buckets for 30d, daily buckets for 365d. Lifetime totals and the observed peak remain; correlation request IDs expire within 24h and are bounded to 2048 pending/2048 completed IDs. Old releases can safely ignore new fields.
5. Missing duration, missing Token payload, duration ≤0, unmatched IDs, oversized/non-text output, dropped worker jobs and log gaps are **not** estimated. A zero reported log-gap count cannot prove 100% measurement coverage. Runtime averages start at their own first matched sample, rather than pretending the historical total had complete duration coverage.
6. `runtimeAverageTokensPerSecond` is a **per completed request work-duration metric**. Concurrent requests sum their own elapsed times; this is useful for comparing typical tool-delivery efficiency but does not represent single-node aggregate wall-clock capacity. For total throughput under concurrency, use wall-clock delivery rates instead.
7. `effective` is a **new, rolling-24h** aggregation starting from newly observed complete requests (not backfilled from legacy counters): `mcp_received` + `mcp_body_ready: tools/call` + `mcp_finished` + `tool_tokens_measured`. `conversation_seen` from `openai/session` identifies *host-associated* calls. It is not a signed identity attestation and must never be labeled proven GPT/direct vs subagent. Unknown-source calls are excluded from host-associated throughput. Subagent CLI/Provider events live in the separate local-agent tables, not in this MCP-text numerator.
8. Overlapping intervals are merged using a start/end sweep, per conversation for one user's tool-active efficiency and globally for parallel Rex delivery. The timer stores bounded request correlation records (up to 4096 for a rolling 24h); when coverage truncates, rates are observational samples, not a proof of the entire 24h. Browser/network telemetry is not yet a reliable ChatGPT turn boundary; **never** call non-tool gaps pure thinking time or show fake end-to-end Token/s.
