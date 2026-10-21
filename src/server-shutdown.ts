export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  drainTimeoutMs = 5_000,
  cleanupTimeoutMs = 12_000,
  onTimeout: (phase: "http_drain" | "application_cleanup") => void = () => undefined,
): Promise<void> {
  httpServer.closeIdleConnections?.();
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  let forceDrain: ReturnType<typeof setTimeout> | undefined;
  try {
    // The HTTP close callback fires after accepted requests have drained.
    // Closing SQLite/routers first can strand an already-dispatched MCP tool
    // against a disposed control plane during a release switch.
    await Promise.race([
      httpClosed,
      new Promise<void>((resolve) => {
        forceDrain = setTimeout(() => {
          onTimeout("http_drain");
          httpServer.closeAllConnections?.();
          // A broken/upgrade connection may never invoke server.close's
          // callback. Do not exceed systemd's bounded stop interval.
          resolve();
        }, drainTimeoutMs);
      }),
    ]);
  } finally {
    if (forceDrain) clearTimeout(forceDrain);
    // Also clean up when HTTP close itself fails. Never close shared state
    // while an accepted request may still be using it.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closeApplication(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            onTimeout("application_cleanup");
            resolve();
          }, cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
