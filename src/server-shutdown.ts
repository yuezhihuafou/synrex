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
    await closeApplication();
    await httpClosed;
  } finally {
    clearTimeout(forceDrain);
  }
}
