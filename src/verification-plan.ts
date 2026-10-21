/** Deterministic verification plans: no hidden model, automatic edits or lossy results. */
export type VerificationCommand = { label: string; program: string; args: string[] };
export type VerificationStage = VerificationCommand[];

const pnpm = (label: string, ...args: string[]): VerificationCommand => ({ label, program: "pnpm", args });

export function verificationPlan(argv: string[]): VerificationStage[] {
  const [mode, ...params] = argv;
  if (mode === "focused") {
    if (params.length === 0 || params.length > 16) throw new Error("focused verification requires 1-16 explicit test files.");
    for (const file of params) {
      if (!/^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.test\.ts$/.test(file)) {
        throw new Error(`Invalid focused test path: ${file}`);
      }
    }
    return [[pnpm("focused-tests", "exec", "tsx", "--test", "--test-concurrency=1", ...params)]];
  }
  if (mode === "final") {
    if (params.length > 1 || params.some((param) => param !== "--build")) {
      throw new Error("final verification accepts only --build.");
    }
    return [
      [pnpm("typecheck", "-s", "typecheck"), pnpm("architecture", "-s", "architecture:check")],
      [pnpm("full-test-suite", "-s", "test")],
      ...(params.includes("--build") ? [[pnpm("production-build", "-s", "build")]] : []),
    ];
  }
  throw new Error("Usage: pnpm verify:focused src/foo.test.ts ... OR pnpm verify:final [--build]");
}
