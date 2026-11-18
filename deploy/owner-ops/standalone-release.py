#!/usr/bin/env python3
"""Guarded immutable Synrex standalone-owner release switch / rollback.

For the PC standalone service only. The swy1 coordinator has its own
ingress-aware activation scripts and must not use this switcher.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.request import Request, urlopen

HOME = Path.home()
SERVICE = "synrex-owner.service"
RELEASES = HOME / "services/synrex-owner/releases"
DROPIN = HOME / ".config/systemd/user/synrex-owner.service.d/20-pinned-runtime.conf"
NODE = HOME / ".local/opt/node-v22.22.2/node"
STATE = HOME / ".local/share/synrex-owner"
CONFIG = HOME / ".config/synrex-owner"
BACKUPS = HOME / ".local/share/synrex-owner-backups"
RUNS = STATE / "runs"
AUDIT = HOME / ".local/share/synrex-owner-rollouts"
LOCK = HOME / ".local/state/synrex-owner-release.lock"
PORT = 8686
ISSUER = "https://4090synrex.yuezhihuafou.com"


def run(*args: str) -> None:
    subprocess.run(list(args), check=True)


def active_release() -> Path:
    out = subprocess.check_output(
        ["systemctl", "--user", "show", SERVICE, "-p", "ExecStart", "--value"],
        text=True,
    )
    match = re.search(r"(/[A-Za-z0-9_./-]+?)/dist/cli\.js", out)
    if not match:
        raise RuntimeError("owner unit is not pinned to an absolute release")
    return Path(match.group(1))


def checked_release(directory: Path) -> dict:
    root = RELEASES.resolve(strict=True)
    if not directory.is_absolute() or directory.is_symlink() or directory.resolve(strict=True).parent != root:
        raise RuntimeError("candidate must be an immutable direct release child")
    path = directory / "release-manifest.json"
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("missing immutable release manifest")
    meta = json.loads(path.read_text())
    if meta.get("sourceDirty") is not False:
        raise RuntimeError("release built from dirty source")
    if not re.fullmatch("[0-9a-f]{40}", meta.get("sourceRevision", "")):
        raise RuntimeError("invalid source SHA")
    if "verified" not in str(meta.get("qa", "")).lower():
        raise RuntimeError("release lacks verified QA evidence")
    assets = meta.get("assets")
    if not isinstance(assets, dict) or not assets:
        raise RuntimeError("missing release checksums")
    for relative, sha in assets.items():
        rel = Path(relative)
        if rel.is_absolute() or ".." in rel.parts or not re.fullmatch("[0-9a-f]{64}", str(sha)):
            raise RuntimeError("unsafe release asset manifest entry")
        file = directory / rel
        if file.is_symlink() or not file.is_file():
            raise RuntimeError(f"release asset missing or symlink: {rel}")
        if hashlib.sha256(file.read_bytes()).hexdigest() != sha:
            raise RuntimeError(f"release asset changed: {rel}")
    build = directory / "dist/build-info.json"
    if build.exists():
        info = json.loads(build.read_text())
        if info.get("revision") != meta["sourceRevision"] or info.get("dirty") is not False:
            raise RuntimeError("release build provenance mismatch")
    return meta


def check_http() -> None:
    with urlopen(Request(f"http://127.0.0.1:{PORT}/healthz"), timeout=4) as local:
        if local.status != 200:
            raise RuntimeError("local /healthz is not ready")
    req = Request(ISSUER + "/.well-known/oauth-authorization-server",
                  headers={"User-Agent": "Mozilla/5.0 (SynrexReleaseCheck)"})
    with urlopen(req, timeout=7) as response:
        meta = json.load(response)
        if meta.get("issuer", "").rstrip("/") != ISSUER:
            raise RuntimeError("OAuth issuer changed after release")


def wait_healthy() -> None:
    last: Exception | None = None
    for _ in range(35):
        try:
            run("systemctl", "--user", "is-active", "--quiet", SERVICE)
            check_http()
            return
        except Exception as error:
            last = error
            time.sleep(1)
    raise RuntimeError(f"post-switch health check failed: {last}")


def write_file_atomic(path: Path, content: bytes) -> None:
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        temp.write_bytes(content)
        temp.chmod(0o644)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def snapshot() -> None:
    script = active_release() / "deploy/backup-owner-state.py"
    run(sys.executable, str(script), "--state-dir", str(STATE),
        "--config-dir", str(CONFIG), "--destination", str(BACKUPS),
        "--runs-dir", str(RUNS), "--keep", "14")


def receipt(path: Path, status: str, old: str, new: str, error: str = "") -> None:
    data = {"at": datetime.now(timezone.utc).isoformat(),
            "status": status, "old": old, "new": new,
            "error": error}
    (path / "receipt.json").write_text(json.dumps(data, indent=2) + "\n")
    (path / "receipt.json").chmod(0o600)


def activate(target: Path, mode: str) -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = active_release()
        old_meta = checked_release(previous)
        target_meta = checked_release(target)
        if target == previous:
            raise RuntimeError("candidate is already active")
        if mode == "activate" and target_meta.get("previousRelease") != previous.name:
            raise RuntimeError("candidate does not record current immutable release as predecessor")
        if mode == "rollback" and old_meta.get("previousRelease") != target.name:
            raise RuntimeError("rollback target is not the recorded previous release")
        if not DROPIN.is_file() or DROPIN.is_symlink() or not NODE.is_file():
            raise RuntimeError("pinned service drop-in or Node runtime is missing")
        run("systemctl", "--user", "is-active", "--quiet", SERVICE)
        check_http()
        snapshot()
        AUDIT.mkdir(parents=True, exist_ok=True, mode=0o700)
        AUDIT.chmod(0o700)
        audit = AUDIT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        audit.mkdir(mode=0o700)
        old_content = DROPIN.read_bytes()
        (audit / "previous-unit.conf").write_bytes(old_content)
        (audit / "previous-unit.conf").chmod(0o600)
        changed = False
        try:
            new_content = (
                "[Service]\n"
                f"Environment=DEVSPACE_COMPACT_RUN_ROOT={RUNS}\n"
                "ExecStart=\n"
                f"ExecStart={NODE} {target}/dist/cli.js serve\n"
            ).encode()
            write_file_atomic(DROPIN, new_content)
            changed = True
            run("systemctl", "--user", "daemon-reload")
            run("systemctl", "--user", "restart", SERVICE)
            wait_healthy()
            run("systemctl", "--user", "is-active", "--quiet", "synrex-peer.service")
            receipt(audit, "activated" if mode == "activate" else "rolled-back",
                    previous.name, target.name)
        except BaseException as error:
            if changed:
                write_file_atomic(DROPIN, old_content)
                run("systemctl", "--user", "daemon-reload")
                run("systemctl", "--user", "restart", SERVICE)
                try:
                    wait_healthy()
                    receipt(audit, "reverted-to-previous", previous.name, target.name, str(error))
                except Exception as restoration:
                    receipt(audit, "recovery-failed", previous.name, target.name, str(restoration))
            raise
        print(f"{mode.upper()}_COMPLETE old={previous.name} new={target.name} audit={audit}")


def main() -> None:
    def interrupted(*_args: object) -> None:
        raise InterruptedError("release switch interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("status", "verify", "activate", "rollback"))
    parser.add_argument("candidate", nargs="?")
    args = parser.parse_args()
    try:
        previous = active_release()
        if args.action == "status":
            meta = checked_release(previous)
            print(json.dumps({"active": previous.name, "revision": meta["sourceRevision"],
                              "previousRelease": meta.get("previousRelease"),
                              "publicIssuer": ISSUER, "rollbackRequiresInstalledPredecessor": True}))
        elif args.action == "verify":
            candidate = Path(args.candidate) if args.candidate else previous
            meta = checked_release(candidate)
            print(json.dumps({"verified": candidate.name, "revision": meta["sourceRevision"],
                              "alreadyActive": candidate == previous}))
        elif args.action == "activate":
            if not args.candidate:
                parser.error("activate requires an immutable release directory")
            activate(Path(args.candidate), "activate")
        else:
            old = checked_release(previous)
            name = old.get("previousRelease")
            if not isinstance(name, str) or not re.fullmatch("[A-Za-z0-9._-]{5,150}", name):
                raise RuntimeError("no recorded previous release to roll back")
            activate(RELEASES / name, "rollback")
    except Exception as error:
        print(f"OWNER_RELEASE_BLOCKED {error}", file=sys.stderr)
        raise SystemExit(75) from error


if __name__ == "__main__":
    main()
