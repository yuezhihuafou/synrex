"""The release CI gate must fail closed without changing remote Git state."""

import importlib.util
import json
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parent.parent / "deploy/check-main-ci.py"
SPEC = importlib.util.spec_from_file_location("synrex_check_main_ci", PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SHA = "a" * 40


def response(*runs):
    return CompletedProcess(
        ["gh"], 0, json.dumps({"workflow_runs": list(runs)}), "",
    )


def run(status="completed", conclusion="success", sha=SHA, event="push", id=12):
    return {"head_sha": sha, "event": event, "status": status,
            "conclusion": conclusion, "id": id}


class MainCIGateTests(unittest.TestCase):
    @patch.object(MODULE.subprocess, "run")
    def test_success_only_for_exact_latest_push(self, command):
        command.return_value = response(run(id=14), run(id=13))
        checked = MODULE.verify(SHA)
        self.assertEqual(checked["run_id"], 14)
        args, kwargs = command.call_args
        self.assertEqual(args[0][:2], ["gh", "api"])
        self.assertIn(f"head_sha={SHA}", args[0][2])
        self.assertEqual(kwargs["timeout"], 30)

    @patch.object(MODULE.subprocess, "run")
    def test_missing_or_mismatched_runs_are_blocked(self, command):
        for result in (response(), response(run(sha="b" * 40)),
                       response(run(event="pull_request"))):
            command.return_value = result
            with self.assertRaisesRegex(ValueError, "no push CI run"):
                MODULE.verify(SHA)

    @patch.object(MODULE.subprocess, "run")
    def test_pending_failed_or_cancelled_latest_run_blocks(self, command):
        for status, conclusion in (
            ("in_progress", None), ("completed", "failure"),
            ("completed", "cancelled"), ("completed", None),
        ):
            command.return_value = response(run(status, conclusion), run(id=3))
            with self.assertRaisesRegex(ValueError, "CI not green"):
                MODULE.verify(SHA)

    @patch.object(MODULE.subprocess, "run")
    def test_unavailable_gh_invalid_response_and_bad_sha_are_blocked(self, command):
        for result in (CompletedProcess(["gh"], 1, "", "auth failed"),
                       CompletedProcess(["gh"], 0, "not-json", ""),
                       CompletedProcess(["gh"], 0, '{"workflow_runs":{}}', "")):
            command.return_value = result
            with self.assertRaises(ValueError):
                MODULE.verify(SHA)
        command.side_effect = TimeoutExpired("gh", 30)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            MODULE.verify(SHA)
        command.assert_called()
        with self.assertRaisesRegex(ValueError, "exact 40"):
            MODULE.verify("main")


if __name__ == "__main__":
    unittest.main()
