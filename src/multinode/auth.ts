import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function generateNodeJoinToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveNodeToken(joinToken: string, nodeId: string): string {
  const digest = createHmac("sha256", joinToken)
    .update("devspace-node-v1\0")
    .update(nodeId)
    .digest("base64url");
  return `dn1_${digest}`;
}

export function safeTokenEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
