import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_RELEASE = /^synrex-main-[a-f0-9]{12}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;

/**
 * A cached, local build identity, never a user-supplied release label.
 * A source checkout and a packaged peer without an Owner release manifest do
 * not have authoritative pinned-Owner identity and return null.
 */
export function expectedPinnedConsoleRelease(moduleUrl: string): string | null {
  let file: string;
  try { file = fileURLToPath(moduleUrl); } catch { return null; }
  const dist = path.dirname(file);
  const release = path.dirname(dist);
  const name = path.basename(release);
  if (path.basename(dist) !== "dist" || !PINNED_RELEASE.test(name)) return null;
  try {
    if (lstatSync(release).isSymbolicLink()) return null;
    const manifest = JSON.parse(readFileSync(path.join(release, "release-manifest.json"), "utf8"));
    const build = JSON.parse(readFileSync(path.join(dist, "build-info.json"), "utf8"));
    if (manifest.release !== name || manifest.sourceDirty !== false || build.dirty !== false ||
      !SOURCE_SHA.test(manifest.sourceRevision) || manifest.sourceRevision !== build.revision ||
      manifest.sourceFingerprint !== build.sourceFingerprint ||
      manifest.sourceRevision.slice(0, 12) !== name.slice("synrex-main-".length)) return null;
    return name;
  } catch { return null; }
}

export function consoleSnapshotReleaseMismatch(
  observedRelease: unknown,
  expectedRelease: string | null,
): boolean {
  // No pinned Owner identity in development or the optional portable peer.
  if (expectedRelease === null) return false;
  return typeof observedRelease !== "string" || observedRelease !== expectedRelease;
}
