# Request and task diagnostics

The coordinator records the observable server path: HTTP ingress **before**
the SDK JSON parser/host checks, body-ready and JSON-RPC method, bearer auth,
MCP dispatch, tool handler, auxiliary learning/mailbox work, headers and local
HTTP finish/early close. A 20-second request watchdog records the active stage
without cancelling the operation. Invalid JSON/oversized bodies are recorded
without echoing their contents. JSON-RPC request IDs are hashed.

Each ingress has a generated `requestId`/`traceId` (also returned as
`x-synrex-request-id`). Tool executions have `callId`; remote dispatches retain
their distinct `nodeRequestId` while carrying the original trace. Peer logs
record delivery, workspace queue wait, execution and completion acknowledgment.
Timeout/late-result events preserve the trace. Peer reconnect/backoff failures
are recorded, rather than silently disappearing in the reconnect loop.

Durable commands store a metadata-only `trace.jsonl` beside their existing run
logs: creation, runner start, spawn, first output, terminal outcome/exit code,
notification result. This survives the HTTP request and service restart. Each
runner writes its own file; it does not race the coordinator's log rotation.
The normal run-retention policy removes the lifecycle file with its run.

```sh
synrex diagnose --minutes 30 --summary --system
synrex diagnose --minutes 1440 --request REQUEST_ID
synrex diagnose --run RUN_ID
```

Run the pinned release CLI when inspecting production, with the production
`DEVSPACE_CONFIG_DIR`. `--system` joins a bounded, sanitized journal timeline of
service stop/start, tunnel reconnects and origin refusal. It reports unavailable
when journald cannot be read. `--request` also matches trace/remote request IDs.
Related local run traces are included automatically (at most 50 per report);
use `--run` for a specific run. Remote runner traces must be read on their owner.
Summary quantiles are server-side measured durations, not ChatGPT round trips.
Nested phases overlap and must not be summed. A completed HTTP response remains
classified as completed even when dispatch cleanup is logged afterwards.

Persistent request metadata is allowlisted: no bearer tokens, request bodies,
shell commands, patches, output contents or arbitrary error messages. Logs are
owner-only, rotated at 8 MiB per file (two files). Rotation is a size bound, not
a guaranteed 24-hour history. Queries state the observable/retained window;
missing earlier records must not be counted as proven hangs. Existing command
output logs retain their existing access and retention behavior.

Boundaries: local HTTP finish means bytes were flushed by the server, **not**
acknowledged by ChatGPT. Cloudflare edge processing, client request queueing,
model reasoning and UI rendering are not observable from Synrex. A validated
Cloudflare Ray ID is retained when supplied, but edge access logs require a
separate provider capability. Do not invent these missing durations or subtract
unmatched requests to claim network latency. Historical requests cannot gain
stage records retrospectively.
