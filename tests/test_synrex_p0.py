"""Isolated P0 inventory tests; no real services are stopped or modified."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parent.parent / "scripts/synrex-p0.py"
spec = importlib.util.spec_from_file_location("synrex_p0", SOURCE)
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def simple_manifest():
    return {
        "schema": 1,
        "endpoints": [
            {"id": "owner", "node": "swy1", "bind": "127.0.0.1", "port": 7676,
             "unit": "devspace.service", "expected": "active", "probe": "/healthz"},
            {"id": "peer", "node": "gateway", "bind": "127.0.0.1", "port": 7676,
             "unit": "devspace.service", "expected": "active"},
            {"id": "relay", "node": "gateway", "bind": "127.0.0.1", "port": 7678,
             "unit": "relay.service", "expected": "active"},
            {"id": "no-public-gateway", "node": "gateway", "bind": "127.0.0.1",
             "port": None, "unit": "cloudflared.service", "expected": "inactive"},
        ],
        "links": [{"from": "relay", "to": "owner"}],
    }


class P0Tests(unittest.TestCase):
    def test_same_port_on_different_nodes_is_allowed(self):
        self.assertEqual(p0.validate_manifest(simple_manifest()), [])

    def test_stable_ingress_reassigns_legacy_port_without_duplicate_listener(self):
        manifest = simple_manifest()
        manifest["endpoints"][0]["id"] = "swy1-core"
        manifest["links"][0]["to"] = "swy1-core"
        manifest["stableIngress"] = {
            "listenPort": 7676, "ingressUnit": "synrex-ingress.service",
            "corePort": 7677, "coreUnit": "devspace.service",
        }
        with patch.object(p0, "listen_sockets", return_value=[
            {"bind": "127.0.0.1", "port": 7676, "unit": "synrex-ingress.service"},
            {"bind": "127.0.0.1", "port": 7677, "unit": "devspace.service"},
        ]), patch.object(p0, "service_status", return_value="active"):
            output = p0.network_inventory(manifest, "swy1", stable_ingress=True)
        self.assertEqual(output["violations"], 0)
        self.assertEqual({e["id"] for e in output["endpoints"]}, {"swy1-core", "swy1-stable-ingress"})

    def test_stable_ingress_requires_explicit_owner_layout(self):
        with self.assertRaisesRegex(ValueError, "public owner"):
            p0.network_inventory(simple_manifest(), "gateway", stable_ingress=True)
        with self.assertRaisesRegex(ValueError, "Missing explicitly"):
            p0.network_inventory(simple_manifest(), "swy1", stable_ingress=True)

    def test_collision_detects_wildcard_and_reused_port(self):
        manifest = simple_manifest()
        manifest["endpoints"].append({"id": "oops", "node": "swy1", "bind": "0.0.0.0",
                                       "port": 7676, "unit": "unwanted.service"})
        self.assertIn("port collision owner / oops", p0.validate_manifest(manifest))

    def test_unknown_link_and_duplicate_id_are_reported(self):
        manifest = simple_manifest()
        manifest["links"][0]["to"] = "not-here"
        manifest["endpoints"].append(dict(manifest["endpoints"][0]))
        problems = p0.validate_manifest(manifest)
        self.assertTrue(any("duplicate endpoint ID" in item for item in problems))
        self.assertTrue(any("unknown link" in item for item in problems))

    @patch.object(p0, "service_status")
    @patch.object(p0, "listen_sockets")
    def test_owner_port_and_disabled_gateway_cloudflare(self, sockets, status):
        sockets.return_value = [
            {"bind": "127.0.0.1", "port": 7676, "unit": "devspace.service"},
            {"bind": "127.0.0.1", "port": 7678, "unit": "relay.service"},
        ]
        status.side_effect = lambda name: "inactive" if name == "cloudflared.service" else "active"
        a = p0.network_inventory(simple_manifest(), "swy1")
        b = p0.network_inventory(simple_manifest(), "gateway")
        self.assertEqual(a["violations"], 0)
        self.assertEqual(b["violations"], 0)

    @patch.object(p0, "service_status", return_value="active")
    @patch.object(p0, "listen_sockets")
    def test_unexpected_wildcard_bind_is_not_accepted(self, sockets, _status):
        sockets.return_value = [{"bind": "0.0.0.0", "port": 7676, "unit": "devspace.service"}]
        output = p0.network_inventory(simple_manifest(), "swy1")
        self.assertEqual(output["endpoints"][0]["status"], "unexpected_wildcard_bind")

    @patch.object(p0, "service_status", return_value="active")
    @patch.object(p0, "listen_sockets", return_value=None)
    def test_unobservable_socket_is_unknown_not_healthy(self, _sockets, _status):
        output = p0.network_inventory(simple_manifest(), "swy1")
        self.assertEqual(output["endpoints"][0]["status"], "unknown_sockets")

    @patch.object(p0, "active_durable_units", return_value=["devspace-task-a.service"])
    @patch.object(p0, "service_status", return_value="active")
    @patch.object(p0, "network_inventory", return_value={"endpoints": [{"id": "swy1-core", "status": "ok"}], "manifestConflicts": []})
    def test_release_refuses_known_busy_task(self, _network, _status, _tasks):
        status = p0.release_readiness(simple_manifest(), "swy1")
        self.assertFalse(status["readyForRestart"])
        self.assertEqual(status["inFlightHttpRequests"], "not_measured_by_preflight")

    @patch.object(p0, "active_durable_units", return_value=["devspace-task-robot.service"])
    @patch.object(p0, "service_status", return_value="active")
    @patch.object(p0, "network_inventory", return_value={"endpoints": [
        {"id": "swy1-core", "status": "ok"}, {"id": "swy1-stable-ingress", "status": "ok"},
    ], "manifestConflicts": []})
    def test_stable_ingress_allows_detached_tasks_after_network_verified(self, _network, _status, _tasks):
        status = p0.release_readiness(simple_manifest(), "swy1", stable_ingress=True)
        self.assertTrue(status["readyForRestart"])
        self.assertEqual(status["activeDurableTaskUnits"], ["devspace-task-robot.service"])
        self.assertTrue(status["stableIngress"])

    @patch.object(p0, "active_durable_units", return_value=[])
    @patch.object(p0, "service_status", return_value="active")
    @patch.object(p0, "network_inventory", return_value={"endpoints": [{"id": "swy1-core", "status": "health_failed"}], "manifestConflicts": []})
    def test_release_refuses_unhealthy_network(self, _network, _status, _tasks):
        self.assertFalse(p0.release_readiness(simple_manifest(), "swy1")["readyForRestart"])

    def test_worktree_inventory_is_read_only_and_find_pending_changes(self):
        with tempfile.TemporaryDirectory(prefix="synrex-p0-") as temp:
            root = Path(temp) / "repo"
            root.mkdir()
            git(root, "init", "-b", "main")
            git(root, "config", "user.email", "test@example.com")
            git(root, "config", "user.name", "test")
            (root / "README").write_text("first\n")
            git(root, "add", "README")
            git(root, "commit", "-m", "base")
            baseline = git(root, "rev-parse", "HEAD")
            work = Path(temp) / "parallel"
            git(root, "worktree", "add", "--detach", str(work), baseline)
            (work / "README").write_text("changed\n")
            (work / "new.txt").write_text("untracked\n")
            report = p0.worktree_inventory(root, baseline)
            self.assertEqual(report["summary"]["total"], 2)
            candidate = next(item for item in report["worktrees"] if item["path"] == str(work))
            self.assertEqual(candidate["trackedChanges"], 1)
            self.assertEqual(candidate["untrackedEntries"], 1)
            self.assertTrue(candidate["needsIntegration"])
            self.assertTrue((work / "new.txt").exists(), "audit must never prune worktrees")

    def test_integration_plan_reports_overlap_without_merge(self):
        with tempfile.TemporaryDirectory(prefix="synrex-merge-plan-") as temp:
            root = Path(temp)
            git(root, "init", "-b", "main")
            git(root, "config", "user.email", "test@example.com")
            git(root, "config", "user.name", "test")
            (root / "shared.txt").write_text("base\n")
            git(root, "add", ".")
            git(root, "commit", "-m", "base")
            git(root, "switch", "-c", "feature")
            (root / "shared.txt").write_text("feature\n")
            git(root, "add", "shared.txt")
            git(root, "commit", "-m", "feature")
            source = git(root, "rev-parse", "HEAD")
            git(root, "switch", "main")
            (root / "shared.txt").write_text("main\n")
            git(root, "add", "shared.txt")
            git(root, "commit", "-m", "main")
            before = git(root, "rev-parse", "HEAD")
            result = p0.integration_plan(root, "main", ["feature", "not-a-commit"])
            self.assertEqual(result["candidates"][0]["state"], "overlapping-changes")
            self.assertEqual(result["candidates"][0]["sha"], source)
            self.assertEqual(result["candidates"][0]["overlappingPaths"], ["shared.txt"])
            self.assertEqual(result["candidates"][1]["state"], "missing-or-inaccessible")
            self.assertEqual(git(root, "rev-parse", "HEAD"), before)


if __name__ == "__main__":
    unittest.main()
