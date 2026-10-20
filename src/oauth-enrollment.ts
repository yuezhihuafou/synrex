import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_WINDOW_MINUTES = 15;
const ENROLLMENT_FILE_NAME = "oauth-enrollment.json";

interface LockedEnrollmentState {
  locked: boolean;
  allowUntilMs: number;
  closeAfterGrant?: boolean;
  pendingGrantHash?: string;
}

export interface OAuthEnrollmentStatus {
  locked: boolean;
  acceptingNewConnections: boolean;
  allowUntilMs?: number;
}

function enrollmentPath(stateDir: string): string {
  return join(stateDir, ENROLLMENT_FILE_NAME);
}

/**
 * An absent policy preserves existing installations' behavior until the owner
 * explicitly locks enrollment. A malformed policy fails closed, not open.
 */
export function getOAuthEnrollmentStatus(
  stateDir: string,
  nowMs = Date.now(),
): OAuthEnrollmentStatus {
  let data: string;
  try {
    data = readFileSync(enrollmentPath(stateDir), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { locked: false, acceptingNewConnections: true };
    }
    return { locked: true, acceptingNewConnections: false };
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid policy");
    const state = parsed as Partial<LockedEnrollmentState>;
    if (typeof state.locked !== "boolean" || typeof state.allowUntilMs !== "number"
      || !Number.isSafeInteger(state.allowUntilMs) || state.allowUntilMs < 0) {
      throw new Error("invalid policy");
    }
    if (state.locked === false) return { locked: false, acceptingNewConnections: true };
    const acceptingNewConnections = state.allowUntilMs > nowMs;
    return {
      locked: true,
      acceptingNewConnections,
      ...(acceptingNewConnections ? { allowUntilMs: state.allowUntilMs } : {}),
    };
  } catch {
    return { locked: true, acceptingNewConnections: false };
  }
}

export function oauthEnrollmentAllowed(stateDir: string, nowMs = Date.now()): boolean {
  return getOAuthEnrollmentStatus(stateDir, nowMs).acceptingNewConnections;
}

/** Immediately prohibit new OAuth registrations, grants and code exchanges. */
export function lockOAuthEnrollment(stateDir: string): void {
  writeLockedState(stateDir, { locked: true, allowUntilMs: 0 });
}

/**
 * Only a local operator can open a short, automatically expiring window. The
 * operation never changes, expires, or revokes previously granted tokens.
 */
export function openOAuthEnrollmentWindow(
  stateDir: string,
  minutes: number,
  nowMs = Date.now(),
  options: { closeAfterGrant?: boolean } = {},
): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
    throw new Error(`OAuth enrollment window must be 1-${MAX_WINDOW_MINUTES} minutes.`);
  }
  if (!getOAuthEnrollmentStatus(stateDir, nowMs).locked) {
    throw new Error("Lock OAuth enrollment first using: devspace oauth lock");
  }
  const allowUntilMs = nowMs + minutes * 60_000;
  writeLockedState(stateDir, { locked: true, allowUntilMs, ...(options.closeAfterGrant ? { closeAfterGrant: true } : {}) });
  return allowUntilMs;
}

function writeLockedState(stateDir: string, state: LockedEnrollmentState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const target = enrollmentPath(stateDir);
  const temporary = join(stateDir, `.${ENROLLMENT_FILE_NAME}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** Password-gated OAuth without an additional enrollment timer. Existing grants are untouched. */
export function usePasswordOnlyEnrollment(stateDir: string): void {
  writeLockedState(stateDir, { locked: false, allowUntilMs: 0 });
}

/** Keep the window recoverable if a token response is lost in transit. */
export function recordOAuthEnrollmentGrant(stateDir: string, tokenHash: string): void {
  let state: LockedEnrollmentState;
  try { state = JSON.parse(readFileSync(enrollmentPath(stateDir), "utf8")) as LockedEnrollmentState; }
  catch { return; }
  if (state?.locked !== true || state.closeAfterGrant !== true || !getOAuthEnrollmentStatus(stateDir).acceptingNewConnections) return;
  writeLockedState(stateDir, { locked: true, allowUntilMs: state.allowUntilMs, closeAfterGrant: true, pendingGrantHash: tokenHash });
}

/** Close only after the newly granted client proves it received its token. */
export function closeOAuthEnrollmentAfterGrant(stateDir: string, tokenHash: string): boolean {
  let state: LockedEnrollmentState;
  try { state = JSON.parse(readFileSync(enrollmentPath(stateDir), "utf8")) as LockedEnrollmentState; }
  catch { return false; }
  if (state?.closeAfterGrant !== true || state.pendingGrantHash !== tokenHash) return false;
  lockOAuthEnrollment(stateDir);
  return true;
}
