# Agent capability benchmark

Synrex changes should be justified by task outcomes, not by feature count. Use the same repository tasks, model, effort, starting commit, timeout, and hidden verification for every variant. Do not use the model's self-assessment as the success label.

Recommended ablations are `baseline`, `compact`, `compact+semantic`, `compact+semantic+governance`, and the full configuration with subagents. Run task order independently of variant and separate cold-index from warm-index runs.

Each JSONL result row must contain `taskId`, `variant`, `success`, `contextBytes`, `toolCalls`, `retries`, `wallTimeMs`, `architectureViolations`, `falsePositiveBlocks`, and `humanInterventions`. `functionalSuccess` records whether the requested behavior works; primary `success` additionally requires the hidden architecture verifier to report zero errors. A feature that works by violating the intended design is therefore not counted as an engineering success. Context, calls, retries, wall time, and interventions are efficiency/operability measures; they must not be traded against success without reporting both.

Provider/transport failures are invalid runs, not model failures. Set `valid=false` with an `invalidReason`; summaries exclude those rows from success and efficiency means while reporting `invalidRuns`. If a variant has zero valid runs, outcome/efficiency means are `null`, not zero, so an unavailable provider cannot look like a 0% success result. For the Codex CLI pilot, `contextBytes` is the persisted JSONL event-trace size, a reproducible wire/context proxy rather than an exact hidden-context measurement. When the provider reports token usage, store `inputTokens` and `outputTokens` as the stronger measure.

## Local Operator pilot

Run the bounded local-operator comparison with:

```bash
pnpm benchmark:local-operator
```

The pilot uses three read-only repository fact-retrieval tasks and semantic
verification rather than exact output formatting. Provider transport failures
and timeouts are marked invalid. After one infrastructure-invalid provider run,
the remaining tasks for that provider are skipped instead of repeatedly
consuming time on the same broken transport.

The 2026-10-04 pilot on the `swy1` RTX 4060 used
`Qwen3.5-4B-Q4_K_M` through llama.cpp Vulkan with a 16K context. The local
operator completed all three valid tasks correctly:

- package metadata: 5.176 s
- daemon constants: 6.190 s
- multi-node protocol constants: 4.166 s
- mean wall time: 5.177 s
- valid success rate: 3/3

The paired Codex provider did not produce a valid comparison row: the first
simple task exceeded the 60 s pilot deadline after earlier runs had also shown
long-lived provider-stream disconnects. That row is infrastructure-invalid, so
this pilot demonstrates that the 4B local operator is viable for the bounded
read-only class; it does **not** demonstrate that the 4B model is generally
better than Codex.

Automatic routing therefore stays conservative: `devspace agents run auto`
sends short, bounded, read-only inspection/reporting tasks to the
`local-operator` profile and leaves mutations, debugging, architecture,
research, security, performance, and other broad tasks on Codex when it is
available.

The next larger local candidate is gated on a demonstrated quality gap. The
Qwen3.5-9B Q4_K_M artifact is about 5.68 GB, while the 4B service occupies about
3.5 GB of an 8.19 GB RTX 4060 with 16K context. Since the 4B pilot passed all
bounded tasks and the 9B model would materially reduce VRAM headroom, the 9B
model is not enabled by default and should not be downloaded merely for model
size.

Compare a result file with:

```bash
pnpm benchmark:compare results.jsonl
```

The controlled architecture-governance pilot can be run with:

```bash
pnpm benchmark:governance
pnpm benchmark:governance -- --provider claude --repeats 3
```

The default governance task set intentionally excludes `explicit-boundary-conflict`.
That task asks the agent to implement a feature in a location that directly conflicts
with the declared architecture, so counting refusal or redirection as an ordinary
functional failure confounds instruction following with architecture quality. Run it
only as a diagnostic with `--tasks explicit-boundary-conflict`.

`summary.json` contains both per-variant metrics and paired baseline/governed deltas.
Provider or transport failures are excluded from both rather than counted as agent
failures.

For deterministic component evidence that does not depend on a model provider, run:

```bash
pnpm benchmark:capabilities
```

This separately checks governance true/false blocking behavior, Serena semantic
reference precision against a text-search baseline, and workflow-learning retrieval
plus validated promotion. These component checks prove mechanism behavior only; they
must not be reported as end-to-end agent-performance gains. End-to-end claims require
the paired agent benchmark under the same provider/model/effort and task set.

It runs the same isolated JavaScript maintenance tasks against a plain baseline and a governed variant. The governed fixture uses the real Synrex architecture checker and a versioned intent file; hidden verification applies the same canonical dependency rules to both variants. `--provider` accepts `codex` or `claude`; `--repeats N` alternates baseline/governed order between repeats to reduce temporal bias. Use `--tasks boundary-pressure` or `--variants governed` for a smaller diagnostic run. This pilot isolates architecture-governance effects; it does not claim to measure the compact MCP/LSP ACI, which requires a separate host-level ablation.

If a hidden verifier is corrected after the model calls have completed, use `pnpm benchmark:governance -- --rescore <run-directory>`. The command preserves the original rows as `results.raw.jsonl`, reruns functional and architecture verification against the saved workspaces without another model call, and regenerates the summary.

When the external model provider is unavailable, the deterministic governance engine can still be checked independently with `pnpm benchmark:governance-engine`. This is not a model-capability benchmark: it measures whether known-good changes are allowed and known-bad dependency/intent changes are blocked, including TS/JS, Python, C/C++, and the explicit architecture-change path.

For architecture-governance experiments, include tasks that legitimately add/move files, tasks that violate a forbidden dependency, tasks that intentionally change the architecture through the explicit change path, and tasks with no architecture change. False-positive blocking is a first-class regression metric.
