#!/usr/bin/env python3
"""Consistent, private DevSpace owner-state snapshot; never stops the live service.

Backups are deliberately separate from immutable application releases. An SQLite
online backup includes WAL transactions; copying the live .sqlite file does not.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile


def owned_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise RuntimeError(f"Refusing untrusted backup directory: {path}")
    path.chmod(0o700)


def copy_private_file(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f"Refusing non-regular source: {source}")
    with source.open("rb") as inp, target.open("xb") as out:
        shutil.copyfileobj(inp, out)
    target.chmod(0o600)
    return True


def snapshot(state_dir: Path, config_dir: Path, destination: Path,
             keep: int, runs_dir: Path | None) -> Path:
    source_db = state_dir / "devspace.sqlite"
    if source_db.is_symlink() or not source_db.is_file():
        raise RuntimeError("The authoritative SQLite database is missing or unsafe")
    owned_directory(destination)
    staging = Path(tempfile.mkdtemp(prefix=".incomplete-", dir=destination))
    staging.chmod(0o700)
    committed = False
    try:
        included_dbs = []
        for db_name in ("devspace.sqlite", "coding-workflows.sqlite"):
            db_path = state_dir / db_name
            if db_name != "devspace.sqlite" and not db_path.exists():
                continue
            if db_path.is_symlink() or not db_path.is_file():
                raise RuntimeError(f"Unsafe SQLite database: {db_path}")
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as live:
                with sqlite3.connect(staging / db_name) as archive:
                    live.backup(archive, pages=128, sleep=0.05)
                    if archive.execute("pragma quick_check").fetchone()[0] != "ok":
                        raise RuntimeError(f"SQLite backup integrity failed: {db_name}")
                    if archive.execute("pragma foreign_key_check").fetchone() is not None:
                        raise RuntimeError(f"SQLite backup foreign-key check failed: {db_name}")
            (staging / db_name).chmod(0o600)
            included_dbs.append(db_name)
        for source, target in (
            (state_dir / "oauth-replay.key", "oauth-replay.key"),
            (state_dir / "oauth-enrollment.json", "oauth-enrollment.json"),
            (config_dir / "auth.json", "auth.json"),
            (config_dir / "config.jsonc", "config.jsonc"),
        ):
            copy_private_file(source, staging / target)
        if runs_dir is not None and runs_dir.exists():
            # This is a best-effort point-in-time copy of append-only run logs;
            # SQLite and OAuth state are the transactionally consistent part.
            if runs_dir.is_symlink() or not runs_dir.is_dir():
                raise RuntimeError("Unsafe runs directory")
            with tarfile.open(staging / "runs.tar.gz", mode="w:gz") as archive:
                archive.add(runs_dir, arcname="runs", recursive=True)
            (staging / "runs.tar.gz").chmod(0o600)

        marker = {
            "schema": 1,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sqliteQuickCheck": "ok",
            "foreignKeys": "ok",
            "databases": included_dbs,
            "includesRunLogs": runs_dir is not None and runs_dir.exists(),
        }
        (staging / "snapshot.json").write_text(json.dumps(marker, indent=2) + "\n")
        (staging / "snapshot.json").chmod(0o600)
        name = "owner-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        complete = destination / name
        staging.rename(complete)
        committed = True
        copies = sorted(path for path in destination.glob("owner-*")
                        if path.is_dir() and (path / "snapshot.json").is_file())
        for obsolete in copies[:-keep]:
            shutil.rmtree(obsolete)
        return complete
    finally:
        if not committed:
            shutil.rmtree(staging, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Backup single-owner DevSpace state")
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--runs-dir", type=Path)
    parser.add_argument("--keep", type=int, default=7)
    args = parser.parse_args()
    if args.keep < 2 or args.keep > 90:
        parser.error("--keep must be between 2 and 90")
    for original in (args.state_dir, args.config_dir, args.runs_dir):
        if original is not None and args.destination.resolve().is_relative_to(original.resolve()):
            parser.error("backup destination must be outside live state directories")
    completed = snapshot(args.state_dir, args.config_dir, args.destination, args.keep, args.runs_dir)
    print(f"Backup verified and committed: {completed}")


if __name__ == "__main__":
    main()
