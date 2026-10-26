"""Stale candidate and no-production-regression checks on genuine local Git commits."""
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "scripts/synrex-release-provenance.py"
spec = importlib.util.spec_from_file_location("synrex_provenance", SOURCE)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def git(root, *args):
    out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr)
    return out.stdout.strip()


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synrex-provenance-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Verifier")
        git(self.repo, "config", "user.email", "verifier@example.test")
        (self.repo / "README").write_text("initial\n")
        git(self.repo, "add", "README")
        git(self.repo, "commit", "-m", "old production")
        self.active = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "README").write_text("new integrated code\n")
        git(self.repo, "add", "README")
        git(self.repo, "commit", "-m", "new main")
        self.main = git(self.repo, "rev-parse", "HEAD")
        self.candidate = self.root / "release"
        (self.candidate / "dist").mkdir(parents=True)
        (self.candidate / "dist/cli.js").write_text("console.log('ready')\n")
        (self.candidate / "dist/build-info.json").write_text(json.dumps({
            "revision": self.main, "dirty": False, "sourceFingerprint": "source-fingerprint",
        }))
        self.manifest = {
            "sourceRevision": self.main, "sourceDirty": False,
            "sourceFingerprint": "source-fingerprint", "qa": "verified integration suite",
            "assets": {},
        }
        self.sync_assets()

    def sync_assets(self):
        self.manifest["assets"] = {
            "dist/cli.js": hashlib.sha256((self.candidate / "dist/cli.js").read_bytes()).hexdigest(),
            "dist/build-info.json": hashlib.sha256((self.candidate / "dist/build-info.json").read_bytes()).hexdigest(),
        }
        (self.candidate / "release-manifest.json").write_text(json.dumps(self.manifest))

    def check(self, main=None, active=None):
        return policy.validate_candidate(self.repo, self.candidate, main or self.main, active or self.active)

    def test_exact_latest_main_descending_from_production_is_valid(self):
        result = self.check()
        self.assertTrue(result["mainExact"] and result["productionIsAncestor"])
        self.assertEqual(result["candidateSha"], self.main)

    def test_old_candidate_cannot_overwrite_newer_main(self):
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "STALE_CANDIDATE"):
            self.check(main=self.active)

    def test_candidate_must_contain_live_production_commit(self):
        git(self.repo, "switch", "-c", "other", self.active)
        (self.repo / "README").write_text("diverged source\n")
        git(self.repo, "add", "README")
        git(self.repo, "commit", "-m", "other feature")
        diverged = git(self.repo, "rev-parse", "HEAD")
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "PRODUCTION_REGRESSION"):
            self.check(active=diverged)

    def test_package_byte_corruption_fails_closed(self):
        (self.candidate / "dist/cli.js").write_text("modified after QA")
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "checksum mismatch"):
            self.check()

    def test_pending_qa_and_dirty_source_are_rejected(self):
        self.manifest["qa"] = "pending tests"
        self.sync_assets()
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "QA evidence"):
            self.check()
        self.manifest["qa"] = "verified tests"
        self.manifest["sourceDirty"] = True
        self.sync_assets()
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "dirty"):
            self.check()

    def test_forged_build_revision_is_rejected(self):
        (self.candidate / "dist/build-info.json").write_text(json.dumps({
            "revision": self.active, "dirty": False, "sourceFingerprint": "source-fingerprint",
        }))
        self.sync_assets()
        with self.assertRaisesRegex(policy.ReleaseProvenanceError, "build info"):
            self.check()


if __name__ == "__main__":
    unittest.main()
