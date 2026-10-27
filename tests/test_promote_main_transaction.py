"""Promotion runs as one serialized, restart-independent owner transaction."""
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent.parent / "deploy/promote-main.sh"


class PromotionTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synrex-promotion-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "source"
        (self.repo / "deploy").mkdir(parents=True)
        (self.repo / "deploy/promote-main.sh").write_text("# placeholder\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "systemd-run.calls"
        launcher = self.bin / "systemd-run"
        launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_CALLS"\n')
        launcher.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FAKE_CALLS": str(self.calls),
        }
        self.env.pop("SYNREX_PROMOTION_WORKER", None)

    def run_script(self, mode, **env):
        return subprocess.run(
            ["bash", str(SCRIPT), mode, str(self.repo)],
            env={**self.env, **env}, capture_output=True, text=True, timeout=10,
        )

    def test_deploy_dispatches_full_transaction_to_independent_systemd_unit(self):
        result = self.run_script("--deploy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PROMOTION_DISPATCHED", result.stdout)
        args = self.calls.read_text().splitlines()
        self.assertIn("--property=Type=exec", args)
        self.assertIn("--setenv=SYNREX_PROMOTION_WORKER=1", args)
        self.assertTrue(any(x.startswith("--unit=synrex-promotion-") for x in args))
        self.assertEqual(args[-4:], ["/bin/bash", str(self.repo / "deploy/promote-main.sh"),
                                     "--deploy", str(self.repo)])
        self.assertFalse((self.home / ".local/state/synrex/owner-release.lock").exists())

    def test_busy_transaction_blocks_candidate_build_before_source_or_core_access(self):
        directory = self.home / ".local/state/synrex"
        directory.mkdir(parents=True)
        with (directory / "owner-release.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for mode, kwargs in [("--check", {}), ("--deploy", {"SYNREX_PROMOTION_WORKER": "1"})]:
                result = self.run_script(mode, **kwargs)
                self.assertEqual(result.returncode, 75, result.stderr)
                self.assertIn("another owner release transaction", result.stderr)
        self.assertFalse(self.calls.exists())


if __name__ == "__main__":
    unittest.main()
