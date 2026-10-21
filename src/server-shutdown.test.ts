import assert from "node:assert/strict";
import { shutdownHttpServer } from "./server-shutdown.js";

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
});

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  false,
  "application state must remain available while accepted HTTP requests drain",
);
assert.ok(finishHttpClose, "HTTP drain must begin before application cleanup");
finishHttpClose();
await drainingShutdown;
assert.equal(applicationCloseStarted, true);

// Simulate an accepted request still reading the shared store during shutdown.
// It must complete before closeApplication disposes that store.
let storeAvailable = true;
let completeRequest: (() => void) | undefined;
let httpCloseCallback: (() => void) | undefined;
const inFlight = new Promise<void>((resolve) => { completeRequest = resolve; });
const activeRequestShutdown = shutdownHttpServer({
  close(callback: (error?: Error) => void) { httpCloseCallback = () => callback(); },
}, async () => { storeAvailable = false; });
await Promise.resolve();
assert.equal(storeAvailable, true);
assert.equal(storeAvailable, true, "an accepted request must see the store while it drains");
completeRequest?.();
await inFlight;
assert.equal(storeAvailable, true);
httpCloseCallback?.();
await activeRequestShutdown;
assert.equal(storeAvailable, false);

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

let forcedClose = false;
let forcedCloseCallback: ((error?: Error) => void) | undefined;
await shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      forcedCloseCallback = callback;
    },
    closeAllConnections() {
      forcedClose = true;
      forcedCloseCallback?.();
    },
  },
  async () => {},
  10,
);
assert.equal(forcedClose, true, "shutdown must bound HTTP drain time");

let cleanupDespiteUnresponsiveHttp = false;
await shutdownHttpServer(
  {
    close(_callback: (error?: Error) => void) { /* A wedged upgraded connection never drains. */ },
    closeAllConnections() {},
  },
  async () => { cleanupDespiteUnresponsiveHttp = true; },
  10, 10,
);
assert.equal(cleanupDespiteUnresponsiveHttp, true);

const httpCloseError = new Error("http close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {},
  ),
  httpCloseError,
);

let cleanedAfterHttpError = false;
await assert.rejects(shutdownHttpServer({
  close(callback: (error?: Error) => void) { callback(httpCloseError); },
}, async () => { cleanedAfterHttpError = true; }), httpCloseError);
assert.equal(cleanedAfterHttpError, true);

let didTimeout = false;
await shutdownHttpServer(
  { close(callback: (error?: Error) => void) { callback(); } },
  () => new Promise<void>(() => undefined),
  10, 10,
  (phase) => { if (phase === "application_cleanup") didTimeout = true; },
);
assert.equal(didTimeout, true, "stalled cleanup must not exhaust systemd's stop budget");
