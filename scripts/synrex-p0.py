#!/usr/bin/env python3
"""Read-only Synrex P0 inventory: worktrees, network ownership, release readiness.

No SSH, restarts, port reservations, source mutations or credential reads.
Run once on each peer: a host reports only what it can actually observe.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def command(argv, cwd=None, timeout=12):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                          timeout=timeout, check=False)


def git(repo, *args):
    result = command(["git", "-C", str(repo), *args], timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git operation failed")
    return result.stdout.strip()


def worktree_records(porcelain):
    records = []
    current = {}
    for line in porcelain.splitlines():
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value if value else True
    if current:
        records.append(current)
    return records


def worktree_inventory(repo, base):
    repo = Path(repo).resolve()
    reference = git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    items = []
    for item in worktree_records(git(repo, "worktree", "list", "--porcelain")):
        path = item["worktree"]
        result = {"path": path, "head": item.get("HEAD"),
                  "branch": item.get("branch", "(detached)"),
                  "locked": "locked" in item}
        if not Path(path).is_dir():
            result["state"] = "missing"
            items.append(result)
            continue
        try:
            status = git(path, "status", "--porcelain=v1", "--untracked-files=normal")
            changes = status.splitlines() if status else []
            divergence = git(path, "rev-list", "--left-right", "--count",
                             f"{reference}...HEAD").split()
            result.update({
                "state": "dirty" if changes else "clean",
                "trackedChanges": sum(1 for x in changes if not x.startswith("??")),
                "untrackedEntries": sum(1 for x in changes if x.startswith("??")),
                "baseOnlyCommits": int(divergence[0]),
                "worktreeOnlyCommits": int(divergence[1]),
                "needsIntegration": bool(changes or int(divergence[1])),
            })
        except (RuntimeError, ValueError) as error:
            result.update({"state": "unknown", "reason": str(error)[:160]})
        items.append(result)
    return {
        "kind": "worktree_inventory", "repo": str(repo),
        "baseRef": base, "baseSha": reference, "worktrees": items,
        "summary": {"total": len(items),
                    "dirty": sum(x["state"] == "dirty" for x in items),
                    "needsIntegration": sum(x.get("needsIntegration", False) for x in items),
                    "unknown": sum(x["state"] in ("unknown", "missing") for x in items)},
        "caveat": "Git worktree inventory is host-local. Review refs and uncommitted work must not be discarded or automatically cherry-picked.",
    }


def integration_plan(repo, base, candidates):
    """Show candidate Git changes and overlap without touching the index or refs.

    A file overlap is a review hint, not proof of a merge conflict. Missing
    cross-host objects are reported explicitly instead of assuming synchronicity.
    """
    repo = Path(repo).resolve()
    base_sha = git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    planned = []
    for candidate in candidates:
        try:
            source_sha = git(repo, "rev-parse", "--verify", f"{candidate}^{{commit}}")
            common = git(repo, "merge-base", base_sha, source_sha)
            candidate_paths = set(git(repo, "diff", "--name-only", common, source_sha).splitlines())
            base_paths = set(git(repo, "diff", "--name-only", common, base_sha).splitlines())
            base_only, candidate_only = (int(x) for x in git(repo, "rev-list", "--left-right", "--count",
                                                             f"{base_sha}...{source_sha}").split())
            overlap = sorted(candidate_paths & base_paths)
            state = ("already-ancestor" if candidate_only == 0 else
                     "overlapping-changes" if overlap else "candidate-review")
            planned.append({"ref": candidate, "sha": source_sha, "commonAncestor": common,
                            "state": state, "baseOnlyCommits": base_only,
                            "candidateOnlyCommits": candidate_only,
                            "changedPaths": sorted(candidate_paths), "overlappingPaths": overlap})
        except RuntimeError as error:
            planned.append({"ref": candidate, "state": "missing-or-inaccessible", "reason": str(error)[:180]})
    return {"kind": "integration_plan", "baseRef": base, "baseSha": base_sha,
            "candidates": planned, "writesPerformed": False,
            "note": "This is only a static Git diff preflight. Inspect dirty work, logical interfaces and tests before cherry-picking; file overlap does not prove textual conflict."}


def overlaps(first, second):
    a, b = first["bind"], second["bind"]
    return (a == b or a in ("0.0.0.0", "::", "*") or b in ("0.0.0.0", "::", "*"))


def validate_manifest(manifest):
    if manifest.get("schema") != 1:
        raise ValueError("Unknown network topology schema")
    by_id = {}
    conflicts = []
    for item in manifest.get("endpoints", []):
        if item["id"] in by_id:
            conflicts.append(f"duplicate endpoint ID {item['id']}")
        by_id[item["id"]] = item
        if item.get("port") is not None:
            port = item["port"]
            if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
                conflicts.append(f"invalid port on {item['id']}")
            for earlier in manifest["endpoints"]:
                if earlier is item:
                    break
                if (earlier.get("node") == item.get("node")
                        and earlier.get("port") == port and overlaps(earlier, item)):
                    conflicts.append(f"port collision {earlier['id']} / {item['id']}")
    for link in manifest.get("links", []):
        if link["from"] not in by_id or link["to"] not in by_id:
            conflicts.append(f"unknown link endpoint {link['from']} -> {link['to']}")
    return conflicts


def listen_sockets():
    rows = []
    output = command(["ss", "-H", "-ltnp"], timeout=10)
    if output.returncode:
        return None
    for line in output.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[3]
        host, _, port = local.rpartition(":")
        if not port.isdigit():
            continue
        pid = re.search(r"pid=(\d+)", line)
        unit = None
        if pid:
            try:
                cgroup = Path(f"/proc/{pid.group(1)}/cgroup").read_text()
                services = re.findall(r"([a-zA-Z0-9_.@-]+\.service)", cgroup)
                unit = services[-1] if services else None
            except OSError:
                pass
        rows.append({"bind": host.strip("[]"), "port": int(port), "unit": unit})
    return rows


def service_status(unit):
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", unit):
        return "unknown"
    output = command(["systemctl", "--user", "show", unit, "-p", "ActiveState"])
    return output.stdout.strip().partition("=")[2] if output.returncode == 0 else "unknown"


def bound_on(endpoint, socket):
    if endpoint["port"] != socket["port"]:
        return False
    actual = socket["bind"]
    expected = endpoint["bind"]
    return (actual == expected or actual == "localhost" and expected == "127.0.0.1"
            or actual in ("*", "0.0.0.0", "::"))


def network_inventory(manifest, node, probe=False):
    conflicts = validate_manifest(manifest)
    sockets = listen_sockets()
    states = {}
    result = []
    for endpoint in manifest["endpoints"]:
        if endpoint["node"] != node:
            continue
        unit = endpoint["unit"]
        if unit not in states:
            states[unit] = service_status(unit)
        actual = states[unit]
        expected = endpoint.get("expected", "active")
        record = {"id": endpoint["id"], "port": endpoint.get("port"),
                  "bind": endpoint.get("bind"), "unit": unit,
                  "activeState": actual, "expected": expected, "status": "ok"}
        if expected != "optional" and actual != expected:
            record["status"] = "service_state_mismatch"
        if endpoint.get("port") is not None:
            matching = [] if sockets is None else [s for s in sockets if bound_on(endpoint, s)]
            if sockets is None:
                record["status"] = "unknown_sockets"
            elif expected == "active" and not matching:
                record["status"] = "port_missing"
            elif matching:
                record["observedBindings"] = [s["bind"] for s in matching]
                record["observedUnits"] = list(dict.fromkeys(s["unit"] for s in matching))
                if any(s["bind"] in ("0.0.0.0", "*", "::") for s in matching):
                    record["status"] = "unexpected_wildcard_bind"
                elif any(s["unit"] is not None and s["unit"] != unit for s in matching):
                    record["status"] = "wrong_port_owner"
            if probe and endpoint.get("probe") == "/healthz" and record["status"] == "ok":
                try:
                    with urlopen(f"http://127.0.0.1:{endpoint['port']}/healthz", timeout=2) as response:
                        record["httpStatus"] = response.status
                    if record["httpStatus"] != 200:
                        record["status"] = "health_failed"
                except (HTTPError, URLError, TimeoutError, OSError):
                    record["status"] = "health_failed"
        result.append(record)
    return {"kind": "network_inventory", "node": node, "endpoints": result,
            "manifestConflicts": conflicts,
            "violations": sum(x["status"] != "ok" for x in result) + len(conflicts),
            "notes": ["Peer endpoints are not probed from this host.",
                      "Remote Cloudflare ingress rules are not visible from local systemd.",
                      "No ports, tunnels or systemd units were modified."]}


def active_durable_units():
    output = command(["systemctl", "--user", "list-units", "--type=service",
                      "--state=running", "--plain", "--no-legend", "--no-pager",
                      "devspace-task-*.service"], timeout=12)
    if output.returncode:
        raise RuntimeError("Unable to enumerate active durable task units")
    return [line.split()[0] for line in output.stdout.splitlines()
            if line.split() and re.fullmatch(r"devspace-task-[^ ]+\.service", line.split()[0])]


def release_readiness(manifest, node):
    if node != "swy1":
        raise ValueError("The production owner is swy1; do not substitute an execution peer")
    network = network_inventory(manifest, node, probe=True)
    critical = set(manifest.get("releaseCriticalEndpoints", ["swy1-core"]))
    critical_issues = [x["id"] for x in network["endpoints"]
                       if x["id"] in critical and x["status"] != "ok"]
    critical_units = manifest.get("releaseCriticalUnits", ["devspace.service", "cloudflared-devspace.service"])
    failed_units = [unit for unit in critical_units if service_status(unit) != "active"]
    tasks = active_durable_units()
    return {"kind": "release_readiness", "node": node,
            "networkViolations": len(critical_issues) + len(network["manifestConflicts"]),
            "criticalEndpointIssues": critical_issues,
            "criticalUnitIssues": failed_units,
            "otherEndpointWarnings": [x["id"] for x in network["endpoints"]
                                      if x["status"] != "ok" and x["id"] not in critical],
            "activeDurableTaskUnits": tasks,
            "readyForRestart": not (critical_issues or network["manifestConflicts"] or failed_units or tasks),
            "inFlightHttpRequests": "unknown",
            "note": "This blocks a known-busy restart; it does NOT prove a zero-interruption handoff or drain MCP requests."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    work = sub.add_parser("worktrees")
    work.add_argument("--repo", default=".")
    work.add_argument("--base", default="origin/main")
    plan = sub.add_parser("integration-plan")
    plan.add_argument("--repo", default=".")
    plan.add_argument("--base", default="origin/main")
    plan.add_argument("--candidate", action="append", required=True)
    net = sub.add_parser("network")
    net.add_argument("--node", choices=["swy1", "gateway"], required=True)
    net.add_argument("--probe", action="store_true")
    ready = sub.add_parser("release-check")
    ready.add_argument("--node", default="swy1", choices=["swy1"])
    for part in (net, ready):
        part.add_argument("--manifest", default=str(Path(__file__).resolve().parent.parent /
                                                     "config/ops/network-topology.json"))
    args = parser.parse_args()
    try:
        if args.action == "worktrees":
            output = worktree_inventory(args.repo, args.base)
        elif args.action == "integration-plan":
            output = integration_plan(args.repo, args.base, args.candidate)
        else:
            manifest = json.loads(Path(args.manifest).read_text())
            output = (network_inventory(manifest, args.node, args.probe)
                      if args.action == "network" else release_readiness(manifest, args.node))
        print(json.dumps(output, ensure_ascii=False, indent=2))
        if args.action == "release-check" and not output["readyForRestart"]:
            return 2
        return 0
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"SYNREX_P0_INSPECTION_FAILED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
