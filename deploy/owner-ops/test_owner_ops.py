"""Offline acceptance tests for Synrex owner operations."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


guard = load_module("owner_guard", "owner-guard.py")
release = load_module("standalone_release", "standalone-release.py")


class OwnerOperationsTests(unittest.TestCase):
    def test_backup_integrity_and_age(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snap = root / "owner-20261118T120000000000Z"
            snap.mkdir()
            with sqlite3.connect(snap / "devspace.sqlite") as db:
                db.execute("create table marker(value integer)")
                db.execute("insert into marker values(1)")
            (snap / "auth.json").write_text("{}")
            (snap / "config.jsonc").write_text("{}")
            created = datetime.now(timezone.utc)
            marker = {"createdAt": created.isoformat(),
                      "databases": ["devspace.sqlite"]}
            (snap / "snapshot.json").write_text(json.dumps(marker))
            self.assertEqual(guard.verify_latest_backup(root, 48)["sqlite"], "ok")
            marker["createdAt"] = (created - timedelta(hours=60)).isoformat()
            (snap / "snapshot.json").write_text(json.dumps(marker))
            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                guard.verify_latest_backup(root, 48)

    def test_manifest_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            candidate = root / "release-good"
            (candidate / "dist").mkdir(parents=True)
            asset = candidate / "dist/cli.js"
            asset.write_text("original")
            digest = hashlib.sha256(asset.read_bytes()).hexdigest()
            (candidate / "release-manifest.json").write_text(json.dumps({
                "sourceDirty": False,
                "sourceRevision": "a" * 40,
                "qa": "verified acceptance",
                "assets": {"dist/cli.js": digest},
            }))
            original = release.RELEASES
            try:
                release.RELEASES = root
                self.assertEqual(release.checked_release(candidate)["sourceRevision"], "a" * 40)
                asset.write_text("tampered")
                with self.assertRaisesRegex(RuntimeError, "asset changed"):
                    release.checked_release(candidate)
            finally:
                release.RELEASES = original


if __name__ == "__main__":
    unittest.main()
