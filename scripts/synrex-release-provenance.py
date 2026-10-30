#!/usr/bin/env python3
"""Fail-closed provenance check before promoting an immutable Synrex release.

The authoritative candidate is the exact current GitHub origin/main commit,
not the latest-looking worktree. The source must also contain the active
production commit. This script only reads Git, systemd and candidate bytes;
it never changes code, unit files, OAuth state, ports or refs.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

CANONICAL_ORIGIN = "https://github.com/yuezhihuafou/synrex.git"
RELEASE_ROOT = Path("/home/swy/services/devspace/releases")


class ReleaseProvenanceError(RuntimeError):
    pass


def command(*args, timeout=30):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ReleaseProvenanceError(f"Failed {args[0]} operation: {result.stderr.strip()[:240]}")
    return result.stdout.strip()


def rev(repo, expression):
    return command("git", "-C", str(repo), "rev-parse", "--verify", f"{expression}^{{commit}}")


def is_ancestor(repo, old, new):
    result = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new],
                            capture_output=True, text=True, timeout=20)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise ReleaseProvenanceError("Git ancestry check failed")


def validate_candidate(repo, candidate, main_sha, active_sha):
    repo, candidate = Path(repo).resolve(), Path(candidate).resolve()
    if not candidate.is_dir() or candidate.is_symlink():
        raise ReleaseProvenanceError("Candidate release directory is missing or unsafe")
    manifest_file = candidate / "release-manifest.json"
    if not manifest_file.is_file() or manifest_file.is_symlink():
        raise ReleaseProvenanceError("Candidate has no trusted release manifest")
    manifest = json.loads(manifest_file.read_text())
    sha = manifest.get("sourceRevision")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ReleaseProvenanceError("Candidate has no exact 40-character source revision")
    if sha != main_sha:
        raise ReleaseProvenanceError(f"STALE_CANDIDATE candidate={sha[:12]} main={main_sha[:12]}")
    if not is_ancestor(repo, active_sha, sha):
        raise ReleaseProvenanceError(
            f"PRODUCTION_REGRESSION active={active_sha[:12]} candidate={sha[:12]}")
    if rev(repo, sha) != sha:
        raise ReleaseProvenanceError("Candidate source commit is unavailable locally")
    if manifest.get("sourceDirty") is not False:
        raise ReleaseProvenanceError("Candidate was built with dirty source")
    qa = manifest.get("qa")
    if not isinstance(qa, str) or not qa or "pending" in qa.lower():
        raise ReleaseProvenanceError("Candidate missing successful QA evidence")
    build_file = candidate / "dist" / "build-info.json"
    if not build_file.is_file() or build_file.is_symlink():
        raise ReleaseProvenanceError("Candidate has no dist build info")
    build = json.loads(build_file.read_text())
    if build.get("revision") != sha or build.get("dirty") is not False:
        raise ReleaseProvenanceError("Candidate build info does not match source commit")
    if manifest.get("sourceFingerprint") != build.get("sourceFingerprint"):
        raise ReleaseProvenanceError("Candidate build fingerprint mismatch")
    assets = manifest.get("assets")
    if not isinstance(assets, dict) or not assets or "dist/cli.js" not in assets:
        raise ReleaseProvenanceError("Candidate missing asset hashes")
    for name, checksum in assets.items():
        if not isinstance(name, str) or not re.fullmatch(r"[0-9a-f]{64}", str(checksum)):
            raise ReleaseProvenanceError("Malformed asset manifest entry")
        file = candidate / name
        if name.startswith("/") or ".." in Path(name).parts or not file.is_file() or file.is_symlink():
            raise ReleaseProvenanceError("Unsafe candidate asset path")
        if hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            raise ReleaseProvenanceError(f"Candidate asset checksum mismatch: {name}")
    return {"candidateSha": sha, "mainSha": main_sha, "activeSha": active_sha,
            "candidate": str(candidate), "assetCount": len(assets),
            "productionIsAncestor": True, "mainExact": True}


def live_active_manifest():
    cmd = command("systemctl", "--user", "show", "devspace.service", "-p", "ExecStart")
    matches = re.findall(r"(/home/swy/services/devspace/releases/[^\s;]+?)/dist/cli\.js", cmd)
    if len(matches) != 1:
        raise ReleaseProvenanceError("Unable to identify exactly one active pinned release")
    release = Path(matches[0]).resolve()
    if release.parent != RELEASE_ROOT:
        raise ReleaseProvenanceError("Production release is outside immutable release root")
    manifest = json.loads((release / "release-manifest.json").read_text())
    active_sha = manifest.get("sourceRevision")
    if not isinstance(active_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", active_sha):
        raise ReleaseProvenanceError("Production release provenance is invalid")
    return active_sha, release


def current_main(repo):
    origin = command("git", "-C", str(repo), "remote", "get-url", "origin")
    if origin.rstrip("/") != CANONICAL_ORIGIN:
        raise ReleaseProvenanceError("Git origin is not the canonical Synrex repository")
    remote = command("git", "-C", str(repo), "ls-remote", "--exit-code", "origin",
                     "refs/heads/main", timeout=35)
    record = remote.split()
    if len(record) != 2 or record[1] != "refs/heads/main":
        raise ReleaseProvenanceError("Cannot uniquely resolve GitHub main")
    main_sha = record[0]
    if not re.fullmatch(r"[0-9a-f]{40}", main_sha):
        raise ReleaseProvenanceError("GitHub main does not resolve to an exact commit")
    if rev(repo, main_sha) != main_sha:
        raise ReleaseProvenanceError("GitHub main commit not fetched locally")
    return main_sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="/home/swy/DevSpace")
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args()
    try:
        active, release = live_active_manifest()
        main_sha = current_main(args.repo)
        result = validate_candidate(args.repo, args.candidate, main_sha, active)
        result.update({"ready": True, "activeRelease": str(release)})
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ReleaseProvenanceError, FileNotFoundError, OSError, ValueError,
            subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print(json.dumps({"ready": False, "reason": str(error)[:400]}))
        return 75


if __name__ == "__main__":
    sys.exit(main())
