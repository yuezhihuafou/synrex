/** Read-only MCP/OAuth endpoint checks for self-hosted installations. */
export interface ConnectionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function hintForNetworkError(error: unknown): string {
  const cause = error instanceof Error && "cause" in error ? error.cause : error;
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "DNS resolution failed. Check the Cloudflare Tunnel published route and CNAME, then try nslookup against 1.1.1.1.";
  }
  if (code === "ECONNREFUSED") return "Connection refused. Confirm Synrex is running and the Tunnel forwards to its local port.";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "Connection timed out. Check network/firewall and Tunnel health.";
  if (code.includes("CERT") || code.includes("TLS")) return "TLS certificate validation failed. Check HTTPS and the hostname.";
  if (error instanceof Error && error.name === "TimeoutError") return "Request timed out. Check host reachability and Tunnel health.";
  return error instanceof Error ? error.message : String(error);
}

export async function probeMcp(url: string, name: string): Promise<ConnectionCheck> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "manual" });
    const header = response.headers.get("www-authenticate") ?? "";
    if (response.status === 401 && /bearer/i.test(header)) {
      return { name, ok: true, detail: "401 Bearer challenge: server reachable, authentication enforced (expected without a token)." };
    }
    const hint = response.status === 502 || response.status === 503
      ? "Tunnel or reverse proxy cannot reach the local Synrex service."
      : response.status === 404
        ? "Route not found. Publish the whole site at the hostname and use /mcp for ChatGPT."
        : response.status === 403 || response.status === 302
          ? "A proxy/Access login or policy may intercept MCP before Synrex OAuth."
          : "Expected HTTP 401 with WWW-Authenticate: Bearer for an unauthenticated MCP request.";
    return { name, ok: false, detail: "HTTP " + response.status + ". " + hint };
  } catch (error) {
    return { name, ok: false, detail: hintForNetworkError(error) };
  }
}

export async function probeOAuthDiscovery(baseUrl: string): Promise<ConnectionCheck> {
  const name = "OAuth resource discovery";
  const url = new URL("/.well-known/oauth-protected-resource/mcp", baseUrl).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "manual" });
    if (response.status !== 200) {
      return { name, ok: false, detail: "HTTP " + response.status + ". OAuth resource metadata must be reachable without a token." };
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("authorization_servers" in value)
      || !Array.isArray(value.authorization_servers) || value.authorization_servers.length === 0) {
      return { name, ok: false, detail: "HTTP 200 but missing OAuth authorization_servers in resource metadata." };
    }
    return { name, ok: true, detail: "HTTP 200 with OAuth authorization server metadata." };
  } catch (error) {
    return { name, ok: false, detail: hintForNetworkError(error) };
  }
}

export async function diagnoseMcpConnections(host: string, port: number, publicBaseUrl: string): Promise<ConnectionCheck[]> {
  const local = await probeMcp("http://" + host + ":" + port + "/mcp", "Local MCP");
  const publicCheck = await probeMcp(new URL("/mcp", publicBaseUrl).toString(), "Public MCP");
  const discovery = publicCheck.ok ? await probeOAuthDiscovery(publicBaseUrl)
    : { name: "OAuth resource discovery", ok: false, detail: "Skipped: public MCP is not reachable yet." };
  return [local, publicCheck, discovery];
}
