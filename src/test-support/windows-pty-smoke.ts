import { ProcessSessionManager } from "../process-sessions.js";

if (process.platform !== "win32") process.exit(0);

const manager = new ProcessSessionManager({ completedSessionTtlMs: 1_000 });
const node = `"${process.execPath}"`;
const pty = await manager.start({
  workspaceId: "workspace-pty",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
  tty: true,
  columns: 80,
  rows: 24,
  yieldTimeMs: 10,
});

if (!pty.running || !pty.sessionId) {
  console.error(JSON.stringify(pty));
  process.exit(2);
}

const resized = await manager.write({
  workspaceId: "workspace-pty",
  sessionId: pty.sessionId,
  columns: 120,
  rows: 30,
  yieldTimeMs: 2_000,
});

if (resized.running || resized.exitCode !== 0 || !/columns:120/.test(resized.output)) {
  console.error(JSON.stringify(resized));
  process.exit(3);
}

console.log("windows ConPTY resize smoke passed");
process.exit(0);
