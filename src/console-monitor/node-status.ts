/** Presentation-only reachability, never a write to the node directory. */
export function displayedNodeHealth(
  node: { kind: string; health: string },
  sampledAt: string | null | undefined,
  directoryAt: string | null | undefined,
  now = Date.now(),
): string {
  const fresh = (timestamp: string | null | undefined, ttl: number) => {
    const value = Date.parse(timestamp ?? "");
    return Number.isFinite(value) && value <= now + 2000 && now - value <= ttl;
  };
  // The Console runs on swy1: only a fresh local sample establishes that the
  // host is reachable. Its DB registration time is NOT a heartbeat.
  if (!fresh(sampledAt, 20_000)) return "unconfirmed";
  if (node.kind === "local") return "online";
  // Remote directory rows may be sampled less often than CPU/process data.
  if (!fresh(directoryAt, 45_000)) return "unconfirmed";
  return node.health;
}
