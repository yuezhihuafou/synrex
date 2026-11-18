#!/usr/bin/env python3
"""Read-only health, backup freshness, and pinned-release integrity guard.

Runs in a systemd user health timer; never issues OAuth tokens or restarts services.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


def check_db(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"missing or unsafe database: {path}")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError(f"SQLite quick_check failed: {path.name}")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError(f"SQLite foreign_key_check failed: {path.name}")


def get_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; SynrexOwnerGuard/1)"})
    for attempt in range(2):
        try:
            with urlopen(req, timeout=8) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}: {url}")
                data = json.load(response)
                if not isinstance(data, dict):
                    raise RuntimeError(f"not a JSON object: {url}")
                return data
        except (URLError, TimeoutError) as exc:
            if attempt:
                raise RuntimeError(f"{url}: {exc}") from exc
            time.sleep(1)
    raise RuntimeError(f"unreachable: {url}")


def service_active(name: str) -> None:
    proc = subprocess.run(["systemctl", "--user", "is-active", "--quiet", name], check=False)
    if proc.returncode:
        raise RuntimeError(f"systemd unit not active: {name}")


def current_release(service: str) -> Path:
    proc = subprocess.run(
        ["systemctl", "--user", "show", service, "--property=ExecStart", "--value"],
        text=True, capture_output=True, check=True,
    )
    match = re.search(r"(/[A-Za-z0-9_./-]+?)/dist/cli\.js", proc.stdout)
    if not match:
        raise RuntimeError(f"service not pinned to release dist/cli.js: {service}")
    release = Path(match.group(1))
    if release.is_symlink() or not release.is_dir():
        raise RuntimeError(f"unsafe or missing pinned release: {release}")
    return release


def verify_release(release: Path) -> dict:
    manifest_file = release / "release-manifest.json"
    if manifest_file.is_symlink() or not manifest_file.is_file():
        raise RuntimeError("pinned release manifest missing")
    manifest = json.loads(manifest_file.read_text())
    if manifest.get("sourceDirty") is not False:
        raise RuntimeError("pinned release built from dirty source")
    if not re.fullmatch(r"[a-f0-9]{40}", manifest.get("sourceRevision", "")):
        raise RuntimeError("invalid source revision in release manifest")
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise RuntimeError("invalid release asset manifest")
    for rel in ("dist/cli.js", "dist/server.js", "dist/build-info.json"):
        sha = assets.get(rel)
        if not isinstance(sha, str):
            raise RuntimeError(f"release asset not tracked: {rel}")
        file = release / rel
        if file.is_symlink() or not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != sha:
            raise RuntimeError(f"release asset checksum mismatch: {rel}")
    return {"release": release.name, "revision": manifest["sourceRevision"][:12]}


def verify_latest_backup(directory: Path, max_hours: float) -> dict:
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError("backup directory absent or unsafe")
    snapshots = sorted(
        (p for p in directory.glob("owner-*") if p.is_dir() and not p.is_symlink() and (p / "snapshot.json").is_file()),
        key=lambda p: p.name,
    )
    if not snapshots:
        raise RuntimeError("no completed owner-state snapshot")
    newest = snapshots[-1]
    marker = json.loads((newest / "snapshot.json").read_text())
    created = datetime.fromisoformat(marker["createdAt"])
    age_hours = (datetime.now(timezone.utc) - created).total_seconds() / 3600
    if not 0 <= age_hours <= max_hours:
        raise RuntimeError(f"last backup age {age_hours:.1f} h exceeds {max_hours:g} h")
    for name in ("auth.json", "config.jsonc", "devspace.sqlite"):
        file = newest / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError(f"backup incomplete: {name}")
    for name in marker.get("databases", []):
        check_db(newest / name)
    return {"snapshot": newest.name, "ageHours": round(age_hours, 1), "sqlite": "ok"}


def check(args: argparse.Namespace) -> dict:
    service_active(args.owner_service)
    service_active(args.tunnel_service)
    if args.ingress_service:
        service_active(args.ingress_service)
    check_db(args.state_dir / "devspace.sqlite")
    latest = verify_latest_backup(args.backup_dir, args.max_backup_age_hours)
    release = verify_release(current_release(args.owner_service))
    local = get_json(f"http://127.0.0.1:{args.local_port}/healthz")
    public = args.public_url.rstrip("/")
    auth = get_json(public + "/.well-known/oauth-authorization-server")
    resource = get_json(public + "/.well-known/oauth-protected-resource/mcp")
    if auth.get("issuer", "").rstrip("/") != public:
        raise RuntimeError("OAuth issuer mismatch")
    if resource.get("resource") != public + "/mcp":
        raise RuntimeError("OAuth resource mismatch")
    return {
        "status": "healthy", "ownerService": args.owner_service,
        "localHealth": local.get("status", "ok"), "oauthIssuer": public,
        "latestBackup": latest, "pinned": release,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner-service", required=True)
    parser.add_argument("--tunnel-service", required=True)
    parser.add_argument("--ingress-service")
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--local-port", type=int, required=True)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--max-backup-age-hours", type=float, default=48)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args), sort_keys=True))
    except Exception as exc:
        print(json.dumps({"status": "failed", "reason": str(exc)}, sort_keys=True))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
