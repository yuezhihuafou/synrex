"""Release promotion refuses fake-success exit codes with failing TAP."""
import subprocess
import tempfile
import unittest
from pathlib import Path


GATE = Path(__file__).resolve().parent.parent / "deploy/check-node-test-summary.sh"


class NodeTestSummaryTests(unittest.TestCase):
    def check(self, contents):
        with tempfile.TemporaryDirectory(prefix="synrex-tap-") as folder:
            path = Path(folder) / "regression.log"
            path.write_text(contents)
            return subprocess.run(["bash", str(GATE), str(path)], capture_output=True, text=True)

    def test_real_success(self):
        self.assertEqual(self.check("# tests 413\n# pass 413\n# fail 0\n").returncode, 0)

    def test_error_even_if_process_would_return_zero(self):
        result = self.check("# tests 413\n# pass 412\n# fail 1\n")
        self.assertEqual(result.returncode, 75)
        self.assertIn("PROMOTION_BLOCKED", result.stderr)

    def test_missing_and_empty_summaries_are_not_success(self):
        self.assertEqual(self.check("no TAP summary\n").returncode, 75)
        self.assertEqual(self.check("# tests 0\n# fail 0\n").returncode, 75)


if __name__ == "__main__":
    unittest.main()
