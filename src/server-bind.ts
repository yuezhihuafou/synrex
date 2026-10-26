/** Process-local listener relocation for a stable, owner-controlled ingress.
 *
 * The public OAuth issuer and persisted server config MUST NOT change when
 * moving the private Core listener behind a loopback-only HTTP gate.
 */
export function resolveCoreListenPort(
  configuredPort: number,
  host: string,
  publicBaseUrl: string,
  value: string | undefined,
): number {
  if (value === undefined || value === "") return configuredPort;
  if (!/^[0-9]{1,5}$/.test(value)) {
    throw new Error("SYNREX_CORE_LISTEN_PORT must be a decimal TCP port");
  }
  const port = Number(value);
  if (port < 1024 || port > 65535) {
    throw new Error("SYNREX_CORE_LISTEN_PORT must be between 1024 and 65535");
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Listener relocation requires a loopback-only Core binding");
  }
  if (!publicBaseUrl.startsWith("https://")) {
    throw new Error("Listener relocation requires an explicit HTTPS public OAuth issuer");
  }
  if (port === configuredPort) return port;
  return port;
}
