"""One-time swy1 ingress cutover QA with faked systemd, curl and sockets."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "deploy/migrate-stable-ingress.sh"


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synrex-p0-migration-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.logs = self.root / "backups"
        self.release = self.root / "release"
        for directory in ("scripts", "dist", "config/ops"):
            (self.release / directory).mkdir(parents=True)
        for file in ("release-manifest.json", "dist/cli.js",
                     "scripts/ingress-gate.mjs", "config/ops/network-topology.json"):
            (self.release / file).write_text("{}")
        (self.release / "scripts/synrex-p0.py").write_text("""
import json,sys
stable="--stable-ingress" in sys.argv
ids=["swy1-core","swy1-cloudflare-metrics"]
if stable: ids.append("swy1-stable-ingress")
print(json.dumps({"endpoints":[{"id":i,"status":"ok"} for i in ids],
                  "manifestConflicts":[]}))
""")
        dropin = self.home / ".config/systemd/user/devspace.service.d/90-owner-pinned-release.conf"
        dropin.parent.mkdir(parents=True)
        dropin.write_text("[Service]\nExecStart=legacy\n")
        self.dropin = dropin
        self.orig = dropin.read_text()
        self.calls = self.root / "calls"
        (self.bin / "systemctl").write_text("""#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
case "$*" in
  *"is-active --quiet synrex-ingress.service"*)
    test -f "$HOME/.ingress-active" ;;
  *"is-active --quiet"*) exit 0 ;;
  *"start synrex-ingress.service"*)
    if test "$FAKE_INGRESS_FAIL" = 1; then exit 1; fi
    touch "$HOME/.ingress-active"; exit 0 ;;
  *"stop synrex-ingress.service"*)
    rm -f "$HOME/.ingress-active"; exit 0 ;;
  *) exit 0 ;;
esac
""")
        (self.bin / "curl").write_text("""#!/bin/sh
case "$*" in
  *"oauth-authorization-server"*) echo '{"issuer":"https://devspace.yuezhihuafou.dpdns.org/"}' ;;
  *) echo '{"ok":true,"name":"devspace"}' ;;
esac
""")
        (self.bin / "ss").write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "sleep").write_text("#!/bin/sh\nexit 0\n")
        for file in self.bin.iterdir():
            file.chmod(0o755)
        self.env = {
            **os.environ, "HOME": str(self.home),
            "FAKE_CALLS": str(self.calls),
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
        }

    def run_cutover(self, **changes):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.release), str(self.logs)],
            env={**self.env, **changes}, capture_output=True, text=True,
            timeout=25,
        )

    def test_first_cutover_success_is_independently_recoverable(self):
        result = self.run_cutover()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.logs / "stable-ingress-cutover.json").read_text())["status"], "activated")
        self.assertIn("Environment=SYNREX_CORE_LISTEN_PORT=7677", self.dropin.read_text())
        calls = self.calls.read_text()
        self.assertIn("restart devspace.service", calls)
        self.assertIn("start synrex-ingress.service", calls)
        self.assertIn("enable synrex-ingress.service", calls)
        self.assertLess(calls.index("restart devspace.service"), calls.index("start synrex-ingress.service"))
        self.assertNotIn("docker", calls)

    def test_ingress_start_failure_restores_previous_owner(self):
        result = self.run_cutover(FAKE_INGRESS_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.dropin.read_text(), self.orig)
        self.assertEqual(json.loads((self.logs / "stable-ingress-cutover.json").read_text())["status"], "rolled-back")
        self.assertIn("STABLE_CUTOVER_ROLLED_BACK", result.stderr)
        self.assertFalse((self.home / ".ingress-active").exists())

    def test_refuses_competing_active_ingress_before_switch(self):
        (self.home / ".ingress-active").touch()
        result = self.run_cutover()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.dropin.read_text(), self.orig)
        self.assertNotIn("restart devspace.service", self.calls.read_text())


if __name__ == "__main__":
    unittest.main()
