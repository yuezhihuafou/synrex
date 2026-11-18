# Synrex control-plane reliability audit — 2026-11-19

## Observed deployment

- swy1: single-owner coordinator / public ingress, pinned 0.4.3 (3675587).
- RTX 4090 PC: execution peer and separate OAuth owner, each pinned 0.4.3 (3675587).
- gateway: independent older execution build reporting 0.1.0.
- Windows: 0.4.2 execution peer and separate 0.4.3 owner. The execution node
  became inaccessible during the audit; do not claim its runtime was upgraded.
- Latest canonical main at the beginning of this review: 0.4.4 (f1ecf42).
  Source publication alone is never evidence of a running release.

## Failure reconstruction

At 22:28:44 CST the coordinator queued a remote call. The client connection
closed around 22:30:49, before the 4090 peer received that request after
approximately 153 seconds of queueing. Actual execution took only about
28 milliseconds. Correlated node request/trace IDs connect those events.

Prior to repair, 8 of 12 direct Node HTTP probes to the Cloudflare coordinator
timed out, whereas 12 of 12 explicitly proxied probes completed. Node 22's
default fetch did not honor the present proxy variables automatically.
4090 now prefers a restricted localhost SSH relay with the Cloudflare URL as
fallback. gateway's previous LAN SSH relay destination was also stale.

## Reviewed defects and changes

1. **Long undelivered queue:** default 180s could outlast ChatGPT's upstream
   response window. A separate 30s undelivered deadline now rejects safely
   before a late peer reconnect can execute the queued command.
2. **Overall RPC window:** default reduced to 100s, below the observed
   approximately 125s client close. Longer-lived hosts may override it;
   delivered ambiguous operations remain explicitly indeterminate.
3. **Control URL failover:** a timed-out primary attempt incorrectly blocked
   the configured secondary URL. Shutdown cancellation remains terminal.
4. **Concurrent duplicate delivery:** a lease-expired request can reach a
   second poller while its original mutation is still executing. Per-ID
   in-flight deduplication now preserves the first execution and receipt.
5. **Slow recovery supervision:** one failed poll previously waited for all
   other pollers, including a long tool execution. Sibling pending polls are
   aborted and reconnection is no longer delayed by unrelated active tools.
6. **Proxy environment mismatch:** explicit Undici environment proxy handling
   works without startup flags, respects local loopback bypass, and leaves
   injected test HTTP clients unchanged.
7. **Weak diagnostics:** each failed peer RPC now records phase, bounded HTTP
   status, and safe allowlisted DNS/TCP error codes including aggregated
   dual-stack failures. A failed primary is recorded even if fallback works.
   No arbitrary error message, command, prompt or credential is persisted.
8. **Telemetry failures interfering with work:** metric callbacks no longer
   control the success or fallback behavior of transport/tool operations.
9. **Unsafe immutable package dependency source:** owner promotion now rejects
   an external node_modules symlink rather than packaging mutable dependencies
   from another checkout.

## Verification and boundaries

New tests cover delayed dispatch without side effects, duplicate active writes,
fallback after timeout, prompt poller recovery, HTTP proxy and loopback routing,
diagnostic redaction, and nonfatal telemetry. A clean-source full regression,
package build, isolated MCP/OAuth smoke, backups, and release provenance checks
are required before switching production.

swy1's stable ingress, OAuth identity, database, existing backup and rollback
must be preserved. PC peer and PC standalone owner are independent deployments.
gateway's older build and inaccessible Windows peer require separate staged
compatibility checks. The physical network, host sleep, third-party edge,
and ChatGPT response stream remain outside Synrex's control. Heartbeat alone
is liveness evidence, not a guarantee of immediate poll capacity.

Never replay a remotely dispatched mutation after an uncertain outcome without
verifying the original request receipt, local task, and causal trace.
