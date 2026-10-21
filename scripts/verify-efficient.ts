import { spawn } from "node:child_process";
import { verificationPlan, type VerificationCommand } from "../src/verification-plan.js";

async function runCommand(command: VerificationCommand): Promise<{ label: string; exitCode: number; elapsedMs: number }> {
  const started = performance.now();
  console.log(`verification_started: ${command.label}`);
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command.program, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
    child.once("error", (error) => { console.error(error); resolve(1); });
    child.once("close", (code) => resolve(code ?? 1));
  });
  const outcome = { label: command.label, exitCode, elapsedMs: Math.round(performance.now() - started) };
  console.log(`verification_finished: ${JSON.stringify(outcome)}`);
  return outcome;
}

async function main(): Promise<void> {
  const plan = verificationPlan(process.argv.slice(2));
  const results: Array<{ label: string; exitCode: number; elapsedMs: number }> = [];
  for (const group of plan) {
    // Only independent checks run concurrently; later stages require the
    // earlier stage to pass. No tests are skipped on a final successful run.
    const finished = await Promise.all(group.map(runCommand));
    results.push(...finished);
    if (finished.some((result) => result.exitCode !== 0)) break;
  }
  const passed = results.length === plan.flat().length && results.every((result) => result.exitCode === 0);
  console.log(`verification_summary: ${JSON.stringify({ passed, checks: results })}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
