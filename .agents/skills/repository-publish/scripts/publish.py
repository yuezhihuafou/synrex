#!/usr/bin/env python3
"""Small fail-closed Git push gate; no dependency on an agent runtime."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


class PublishError(Exception):
    pass


def git(*args, cwd=None, check=True):
    cp = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if check and cp.returncode:
        raise PublishError(f"git {args[0]} failed: {cp.stderr.strip() or cp.stdout.strip()}")
    return cp


def value(*args, cwd=None):
    return git(*args, cwd=cwd).stdout.strip()


def require(condition, message):
    if not condition:
        raise PublishError(message)


def canonical(url):
    """Compare HTTPS/SSH spellings of the same GitHub repository, not redirects."""
    url = url.strip().removesuffix("/").removesuffix(".git")
    for pattern in (r"https://github\.com/([^/]+/[^/]+)$", r"git@github\.com:([^/]+/[^/]+)$", r"ssh://git@github\.com/([^/]+/[^/]+)$"):
        match = re.fullmatch(pattern, url, flags=re.I)
        if match:
            return match.group(1).casefold()
    return None


def policy(path):
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "policy.json"
    cfg = json.loads(p.read_text(encoding="utf-8"))
    for key in ("canonical_origin", "default_branch", "production_service"):
        require(cfg.get(key), f"Missing policy: {key}")
    require(canonical(cfg["canonical_origin"]), "Policy must name a GitHub repository")
    require(re.fullmatch(r"[A-Za-z0-9._/-]+", cfg["default_branch"]), "Invalid default branch")
    return cfg


def remote_info(root, cfg):
    url = value("config", "--get", "remote.origin.url", cwd=root)
    require(canonical(url) == canonical(cfg["canonical_origin"]),
            f"Origin mismatch: {url} (expected {cfg['canonical_origin']})")
    lines = value("ls-remote", "--symref", "origin", "HEAD", cwd=root).splitlines()
    refs = [line.split()[1] for line in lines if line.startswith("ref: ")]
    default = refs[0].removeprefix("refs/heads/") if refs else None
    require(default == cfg["default_branch"],
            f"Remote default branch is {default!r}, expected {cfg['default_branch']!r}")
    target = f"refs/heads/{cfg['default_branch']}"
    remote_rows = value("ls-remote", "origin", target, cwd=root).splitlines()
    require(len(remote_rows) == 1, f"Expected one remote {target}, found {len(remote_rows)}")
    return url, default, remote_rows[0].split()[0]


def repo_state(root):
    return {
        "repository": str(root),
        "branch": value("branch", "--show-current", cwd=root) or "(detached)",
        "head": value("rev-parse", "HEAD", cwd=root),
        "clean": not bool(value("status", "--porcelain=v1", "--untracked-files=normal", cwd=root)),
    }


def inspect_production(cfg):
    cp = subprocess.run(["systemctl", "--user", "show", cfg["production_service"], "-p", "ExecStart"],
                        text=True, capture_output=True)
    require(cp.returncode == 0, f"Cannot inspect service: {cp.stderr.strip()}")
    match = re.search(r"(/[^\s;]+/releases/[^\s;/]+)/(?:dist/cli\.js)", cp.stdout)
    require(match is not None, "Active release is not a pinned /releases/.../dist/cli.js build")
    release = Path(match.group(1))
    manifest = release / "release-manifest.json"
    require(manifest.is_file(), f"Missing immutable release manifest: {manifest}")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    sha = data.get("sourceRevision")
    require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid release sourceRevision")
    return {"service": cfg["production_service"], "release": str(release), "sourceRevision": sha}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["inspect", "push-main", "inspect-production"])
    parser.add_argument("--repo", default=".", help="Repository checkout to inspect or publish")
    parser.add_argument("--policy", help="Override project's policy.json")
    args = parser.parse_args(argv)
    cfg = policy(args.policy)
    if args.operation == "inspect-production":
        print(json.dumps(inspect_production(cfg), indent=2))
        return 0
    root = Path(value("rev-parse", "--show-toplevel", cwd=args.repo)).resolve()
    state = repo_state(root)
    url, default, remote_sha = remote_info(root, cfg)
    state.update({"origin": url, "remote_default": default, "remote_sha": remote_sha})
    if args.operation == "inspect":
        print(json.dumps(state, indent=2))
        return 0
    branch = cfg["default_branch"]
    require(state["branch"] == branch,
            f"Current branch {state['branch']!r} is not {branch!r}; integrate selected commits into main first")
    require(state["clean"], "Working tree/index is dirty or has untracked files; scope and commit before push")
    git("fetch", "--no-tags", "origin", f"refs/heads/{branch}:refs/remotes/origin/{branch}", cwd=root)
    local_sha = state["head"]
    fetched = value("rev-parse", f"refs/remotes/origin/{branch}", cwd=root)
    require(fetched == remote_sha, "Remote changed during preflight; inspect again")
    is_ff = git("merge-base", "--is-ancestor", fetched, local_sha, cwd=root, check=False).returncode == 0
    require(is_ff, f"Non-fast-forward: remote {branch}={fetched}, local HEAD={local_sha}; integrate, do not force")
    if fetched != local_sha:
        git("push", "origin", f"HEAD:refs/heads/{branch}", cwd=root)
    rows = value("ls-remote", "origin", f"refs/heads/{branch}", cwd=root).splitlines()
    require(len(rows) == 1 and rows[0].split()[0] == local_sha,
            "Push result not verified: remote SHA differs from intended local SHA")
    print(json.dumps({"result": "already-current" if fetched == local_sha else "pushed",
                      "destination": f"origin/{branch}", "sha": local_sha}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PublishError, OSError, ValueError) as error:
        print(f"PUBLISH BLOCKED: {error}", file=sys.stderr)
        sys.exit(2)
