#!/usr/bin/env python3
"""Require a successful completed GitHub push CI run for an exact main SHA.

This is a read-only release gate, not a deployment mechanism. Unknown,
pending, missing, or failed results block promotion (exit 75).
"""

import argparse
import json
import re
import subprocess
import sys


WORKFLOW_RUNS = "repos/yuezhihuafou/synrex/actions/workflows/ci.yml/runs"


def verify(sha: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("source revision must be an exact 40-character commit SHA")
    try:
        response = subprocess.run(
            ["gh", "api", f"{WORKFLOW_RUNS}?head_sha={sha}&event=push&per_page=20"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"GitHub CI lookup unavailable: {error}") from error
    if response.returncode != 0:
        raise ValueError(f"GitHub CI lookup failed: {response.stderr.strip()[:240]}")
    try:
        payload = json.loads(response.stdout)
        runs = payload["workflow_runs"]
        if not isinstance(runs, list):
            raise TypeError("workflow_runs must be a list")
        matching = [run for run in runs
                    if run.get("head_sha") == sha and run.get("event") == "push"]
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise ValueError(f"invalid GitHub CI response: {error}") from error
    if not matching:
        raise ValueError("no push CI run for this exact commit")
    # GitHub returns the newest workflow run first. A rerun updates the same
    # workflow-run record; never accept an older successful run over a failure.
    run = matching[0]
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError(
            f"CI not green: run={run.get('id')} status={run.get('status')} "
            f"conclusion={run.get('conclusion')}"
        )
    if not isinstance(run.get("id"), int):
        raise ValueError("GitHub CI run lacks a valid ID")
    return {"sha": sha, "run_id": run["id"],
            "url": f"https://github.com/yuezhihuafou/synrex/actions/runs/{run['id']}"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha")
    args = parser.parse_args()
    try:
        result = verify(args.sha)
        print(f"CI_GATE_PASSED sha={result['sha']} run={result['run_id']} url={result['url']}")
        return 0
    except ValueError as error:
        print(f"CI_GATE_BLOCKED {error}", file=sys.stderr)
        return 75


if __name__ == "__main__":
    sys.exit(main())
