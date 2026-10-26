"""Regression tests for concurrent owner activation; systemd/curl are faked."""
import fcntl
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent.parent / "deploy/activate-owner-release.sh"


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synrex-activation-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "systemctl.calls"
        self.release = self.root / "release"
        for part in ["dist", "scripts", "config/ops"]:
            (self.release / part).mkdir(parents=True)
        (self.release / "dist/cli.js").write_text("// fake candidate")
        (self.release / "release-manifest.json").write_text(json.dumps({"sourceRevision": "a" * 40}))
        (self.release / "config/ops/network-topology.json").write_text("{}")
        (self.release / "scripts/synrex-p0.py").write_text(
            "import os,sys,json\nprint(json.dumps({'readyForRestart': not os.getenv('FAKE_BUSY')}))\n"
            "sys.exit(2 if os.getenv('FAKE_BUSY') else 0)\n")
        (self.bin / "systemctl").write_text(
            "#!/bin/sh\necho \"$*\" >>\"$FAKE_SYSTEMD_CALLS\"\n"
            "if [ \"$2\" = restart ] && [ \"$FAKE_RESTART_FAIL\" = 1 ] "
            "&& [ ! -e \"$HOME/.mock-restart-failed\" ]; then "
            "touch \"$HOME/.mock-restart-failed\"; exit 1; fi\n"
            "exit 0\n")
        (self.bin / "curl").write_text("#!/bin/sh\nexit 0\n")
        for command in ["systemctl", "curl"]:
            (self.bin / command).chmod(0o755)
        self.backup = self.root / "backups"
        self.env = {
            **os.environ, "HOME": str(self.home),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FAKE_SYSTEMD_CALLS": str(self.calls),
        }

    def activate(self, **changes):
        return subprocess.run(["bash", str(SCRIPT), str(self.release), str(self.backup)],
                              env={**self.env, **changes}, capture_output=True, text=True, timeout=10)

    def test_busy_preflight_never_calls_systemctl(self):
        result = self.activate(FAKE_BUSY="1")
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(self.calls.exists())
        self.assertFalse((self.home / ".config/systemd/user/devspace.service.d/90-owner-pinned-release.conf").exists())
        report = json.loads((self.backup / "preflight.json").read_text())
        self.assertFalse(report["readyForRestart"])

    def test_activation_switches_only_after_preflight(self):
        result = self.activate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OWNER_RELEASE_ACTIVATED", result.stdout)
        self.assertIn("restart devspace.service", self.calls.read_text())
        dropin = self.home / ".config/systemd/user/devspace.service.d/90-owner-pinned-release.conf"
        self.assertIn(str(self.release / "dist/cli.js"), dropin.read_text())

    def test_rejects_concurrent_activation_without_touching_release(self):
        directory = self.home / ".local/state/synrex"
        directory.mkdir(parents=True)
        with (directory / "owner-release.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.activate()
            self.assertEqual(result.returncode, 75)
            self.assertIn("already running", result.stderr)
        self.assertFalse(self.calls.exists())

    def test_failed_activation_restores_previous_dropin(self):
        dropin = self.home / ".config/systemd/user/devspace.service.d/90-owner-pinned-release.conf"
        dropin.parent.mkdir(parents=True)
        dropin.write_text("previous pinned core\n")
        # The test fake fails restart, so the old configuration must survive.
        result = self.activate(FAKE_RESTART_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(dropin.read_text(), "previous pinned core\n")
        self.assertIn("OWNER_RELEASE_ROLLED_BACK", result.stderr)


if __name__ == "__main__":
    unittest.main()
