# Synrex V1 recovery/benchmark evidence — 2026-10-22

Status: **pinned swy1 owner deployed**, not a claim of final V1.0 performance acceptance.

- Release: `20261022-synrex-v1-recovery-3367d6a`, clean source
  `3367d6a3b4e577a1846172af58c7e7f086e521d7`, 431 dist files,
  dist-tree SHA256 `a29063618718e916615d2421f2510ef89b77387a16b48bcb01111318f277b9f3`;
  tool schema `681793d91e0578d7e274`, 17 tools.
- Previous `20261022-synrex-efficiency-v1-147af0e` and earlier pinned releases remain in place;
  the gateway was **not** replaced and still advertises matching 17/17 tool contracts.
- New independent deterministic fault injection: remote exec applies one
  simulated side effect then drops its acknowledgment. Router does not retry;
  reopening the workspace recovers stable global task and workspace IDs.
  This is a unit-level lost-reply simulation, not a WAN/real-write loss claim.
- Benchmark records may now leave `contextBytes` absent if the ChatGPT host
  does not expose it. Aggregates return `null` when all contexts are unknown;
  no imaginary zero is inserted.
- New-chat handoff in an actual ordinary ChatGPT conversation successfully
  restored `wf_d8ec6462633c505e20431c3c` revision 3 and detected Git
  drift (`211b2e3` checkpoint vs `12a4486` current before this patch).
- Focused routing/benchmark tests **14/14 pass**,
  run `run_20261022050741_bdce08e9`; TypeScript and architecture checks
  passed, 0 architecture errors/warnings.
- Full test suite **303 passed, 0 failed, 1 skipped**,
  run `run_20261022050817_368b59f7`; offline clean build/source check,
  package-install smoke and isolated authenticated 17-tool HTTP MCP/OAuth/Console
  QA passed. QA task `task_87d84ab299a24ee2` / run
  `run_20261022050905_8b1bc421` verified mailbox, Final Barrier,
  durable/workflow restart recovery and Console authorization.
- Private pre-switch owner-state backup:
  `/home/swy/services/devspace/backups/v1-recovery-3367d6a-owner-precutover/owner-20261022T051015737170Z`.
  Release activated via independent systemd
  `synrex-v1-recovery-3367d6a-activate.service`: result=success,
  exit=0; owner `devspace.service` PID 3730192 pinned to the new release.
  Postflight local health 200, unauthenticated MCP 401, Console 200,
  public OAuth discovery 200. Actual authenticated
  `workflow_status` worked through the new release.

Still unverified: matched same-task/model/effort original-Dev comparison,
quantitative end-to-end 20% time/call or 50% intervention improvement,
true WAN partitions, uncertain remote non-idempotent physical writes, and
automatic GPT reasoning resumption after a closed turn. No such claims are
drawn from this fault fixture or microbenchmarks.
