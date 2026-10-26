"""Isolated Git regression tests; no external network or real GitHub writes."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("publish.py")
POLICY = Path(__file__).resolve().parent.parent / "policy.json"
URL = "https://github.com/yuezhihuafou/synrex.git"


def git(cwd, *args, ok=True):
    cp = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if ok and cp.returncode:
        raise AssertionError(f"git {args}: {cp.stderr}")
    return cp.stdout.strip()


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.bare = self.dir / "upstream.git"
        self.repo = self.dir / "working"
        git(self.dir, "init", "--bare", "--initial-branch=main", str(self.bare))
        git(self.dir, "clone", str(self.bare), str(self.repo))
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        (self.repo / "a.txt").write_text("one")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-m", "initial")
        git(self.repo, "push", "origin", "main")
        git(self.repo, "remote", "set-url", "origin", URL)
        # HTTP GitHub origin is rewritten to a local bare repo for end-to-end tests.
        git(self.repo, "config", f"url.file://{self.bare}.insteadOf", URL)

    def call(self, operation):
        return subprocess.run([sys.executable, str(SCRIPT), operation, "--repo", str(self.repo), "--policy", str(POLICY)], text=True, capture_output=True)

    def new_commit(self, suffix):
        (self.repo / "a.txt").write_text(suffix)
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-m", suffix)

    def test_push_main_and_idempotence(self):
        self.new_commit("two")
        first = self.call("push-main")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout)["result"], "pushed")
        self.assertEqual(git(self.bare, "rev-parse", "refs/heads/main"), git(self.repo, "rev-parse", "HEAD"))
        second = self.call("push-main")
        self.assertEqual(json.loads(second.stdout)["result"], "already-current")

    def test_feature_branch_not_pushed(self):
        git(self.repo, "switch", "-c", "feature/experiment")
        self.new_commit("feature")
        cp = self.call("push-main")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("is not 'main'", cp.stderr)
        self.assertNotEqual(git(self.bare, "rev-parse", "main"), git(self.repo, "rev-parse", "HEAD"))

    def test_dirty_tree_not_pushed(self):
        self.new_commit("two")
        (self.repo / "untracked.txt").write_text("oops")
        cp = self.call("push-main")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("dirty", cp.stderr)

    def test_divergence_not_pushed(self):
        self.new_commit("local")
        git(self.bare, "config", "receive.denyNonFastForwards", "true")
        peer = self.dir / "peer"
        git(self.dir, "clone", str(self.bare), str(peer))
        git(peer, "config", "user.email", "peer@example.com")
        git(peer, "config", "user.name", "Peer")
        (peer / "remote.txt").write_text("remote")
        git(peer, "add", "remote.txt")
        git(peer, "commit", "-m", "other")
        git(peer, "push", "origin", "main")
        cp = self.call("push-main")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("Non-fast-forward", cp.stderr)

    def test_detached_head_not_pushed(self):
        git(self.repo, "checkout", "--detach")
        cp = self.call("push-main")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("not 'main'", cp.stderr)

    def test_default_branch_mismatch_rejected(self):
        git(self.bare, "symbolic-ref", "HEAD", "refs/heads/another")
        cp = self.call("inspect")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("Remote default branch", cp.stderr)

    def test_origin_mismatch_rejected(self):
        git(self.repo, "config", "remote.origin.url", "https://github.com/other/other.git")
        cp = self.call("inspect")
        self.assertEqual(cp.returncode, 2)
        self.assertIn("Origin mismatch", cp.stderr)


if __name__ == "__main__":
    unittest.main()
