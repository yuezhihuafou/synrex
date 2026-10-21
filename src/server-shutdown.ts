export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  drainTimeoutMs = 5_000,
): Promise<void> {
  httpServer.closeIdleConnections?.();
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const forceDrain = setTimeout(() => {
    httpServer.closeAllConnections?.();
  }, drainTimeoutMs);
  try {
    // The HTTP close callback fires after accepted requests have drained.
    // Closing SQLite/routers first can strand an already-dispatched MCP tool
    // against a disposed control plane during a release switch.
    await httpClosed;
  } finally {
    clearTimeout(forceDrain);
    // Also clean up when HTTP close itself fails. Never close shared state
    // while an accepted request may still be using it.
    await closeApplication();
  }
}
