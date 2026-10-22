import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createMonitorApp } from "../src/console-monitor/server.js";
import { MonitorCollector } from "../src/console-monitor/collector.js";
import { validatePeerConfig } from "../src/console-monitor/peers.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, "run-root": { type: "string" }, "monitor-dir": { type: "string" },
  "auth-file": { type: "string" }, "origin": { type: "string", multiple: true }, "port": { type: "string", default: "4318" },
  "host": { type: "string", default: "127.0.0.1" }, "write-root": { type: "string", multiple: true },
  "release": { type: "string", default: "independent-monitor" },
  "peer-ssh": { type: "string", multiple: true },
} });
if (!values["state-dir"] || !values["run-root"] || !values["monitor-dir"] || !values["auth-file"]) {
  console.error("Usage: tsx scripts/console-monitor.ts --state-dir DIR --run-root DIR --monitor-dir NEW_DIR --auth-file OWNER_AUTH_JSON [--origin URL] [--port 4318] [--write-root EXACT_WORKSPACE] [--peer-ssh NODE=SSH_ALIAS]");
  process.exit(2);
}
const auth = JSON.parse(await readFile(values["auth-file"], "utf8")) as { ownerToken?: string };
process.umask(0o077);
if (typeof auth.ownerToken !== "string" || !auth.ownerToken) throw new Error("Owner authentication required");
const stateDir = await realpath(values["state-dir"]), runRoot = await realpath(values["run-root"]);
const monitorDir = path.resolve(values["monitor-dir"]);
if (monitorDir === stateDir || monitorDir.startsWith(stateDir + path.sep) || monitorDir === runRoot || monitorDir.startsWith(runRoot + path.sep)) throw new Error("Monitor storage must be separate from observed state and runs");
const writableRoots = await Promise.all((values["write-root"] ?? []).map(p => realpath(p)));
const peers = Object.fromEntries((values["peer-ssh"] ?? []).map(validatePeerConfig));
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
const origins = values.origin ?? [`http://127.0.0.1:${port}`];
const origin = origins[0];
const collector = new MonitorCollector({ stateDir, runRoot, database: path.join(monitorDir, "statistics.sqlite"), writableRoots, release: values.release, peerSsh: peers });
const app = createMonitorApp({ collector, password: auth.ownerToken, publicOrigin: origin, additionalOrigins: origins.slice(1),
  assets: fileURLToPath(new URL("../dist-console", import.meta.url)) });
const server = app.listen(port, values.host, () => { collector.start(); console.log(`Synrex independent console: ${origin}/console/`); });
server.on("error", error => { console.error("Console listener failed:", error.message); void collector.stop(); process.exitCode = 1; });
const stop = () => { server.close(); server.closeAllConnections(); void collector.stop().finally(() => process.exit(0)); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
