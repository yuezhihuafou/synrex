export interface ReleaseSourceEvidence {
  head: string | null;
  sourceDirty: boolean | null;
  buildRevision: string | null;
  buildDirty: boolean | null;
  currentFingerprint: string | null;
  buildFingerprint: string | null;
  requiredAssetsPresent: boolean;
}

/**
 * Immutable-release source gate. Checks facts, not labels in a release
 * manifest; never treats a dirty checkout build as reproducible.
 */
export function evaluateReleaseSource(evidence: ReleaseSourceEvidence): string[] {
  const failures: string[] = [];
  if (!evidence.head || !evidence.buildRevision || evidence.head !== evidence.buildRevision) {
    failures.push("Build revision must match the source checkout HEAD.");
  }
  if (evidence.sourceDirty !== false || evidence.buildDirty !== false) {
    failures.push("Source and recorded build must both be Git-clean.");
  }
  if (!evidence.currentFingerprint || !evidence.buildFingerprint
    || evidence.currentFingerprint !== evidence.buildFingerprint) {
    failures.push("Build source fingerprint must match current source files.");
  }
  if (!evidence.requiredAssetsPresent) {
    failures.push("Release candidate is missing required runtime assets.");
  }
  return failures;
}
