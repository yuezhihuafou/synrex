/** Advisory classification, never a reason for autonomous replay of writes. */
export type FailureKind = "recoverable" | "requires_authorization" | "external_blocker" | "indeterminate";
export interface FailureAssessment {
  kind: FailureKind;
  next: "diagnose_and_retry_safely" | "request_authorization" | "verify_external_dependency" | "inspect_evidence";
  confidence: "evidence_based" | "unknown";
}
const AUTH = /\b(?:EACCES|EPERM|permission denied|not authorized|unauthorized|forbidden|approval required|requires (?:authorization|permission)|403 forbidden)\b/i;
const TRANSIENT = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporary failure|timed out|connection reset|network is unreachable|fetch failed|502 bad gateway|503 service unavailable)\b/i;
const REPAIRABLE = /\b(?:ENOENT|module not found|cannot find module|dependency missing|assertionerror|testcodefailure|compilation failed|build failed|command not found|failed tests?)\b/i;
const EXTERNAL = /\b(?:account suspended|quota permanently exhausted|resource has been deleted|service discontinued|resource no longer exists)\b/i;

export function assessFailure(input: { exitCode?: number | null; error?: string; knownExpected?: boolean }): FailureAssessment {
  const text = (input.error ?? "").slice(0, 8192);
  if (input.knownExpected || input.exitCode === 0) return { kind: "indeterminate", next: "inspect_evidence", confidence: "unknown" };
  if (AUTH.test(text)) return { kind: "requires_authorization", next: "request_authorization", confidence: "evidence_based" };
  if (EXTERNAL.test(text)) return { kind: "external_blocker", next: "verify_external_dependency", confidence: "evidence_based" };
  if (TRANSIENT.test(text) || REPAIRABLE.test(text)) {
    return { kind: "recoverable", next: "diagnose_and_retry_safely", confidence: "evidence_based" };
  }
  return { kind: "indeterminate", next: "inspect_evidence", confidence: "unknown" };
}

export function failureGuidance(assessment: FailureAssessment): string {
  switch (assessment.kind) {
    case "recoverable": return "Recoverable-looking failure: inspect evidence, try an authorized fix/alternative, verify the original goal. Never blindly replay writes.";
    case "requires_authorization": return "Authorization boundary: do not bypass permissions. Inspect the exact requirement and ask only for missing authority.";
    case "external_blocker": return "External blocker indicated: verify current availability and feasible alternatives before declaring the user's goal blocked.";
    default: return "Failure cause unclassified: inspect run logs and original acceptance criteria before choosing the next safe step.";
  }
}
