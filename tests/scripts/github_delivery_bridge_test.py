import importlib.machinery
import unittest
from pathlib import Path


BRIDGE = importlib.machinery.SourceFileLoader(
    "github_delivery_bridge",
    str(Path(__file__).parents[2] / "scripts" / "github-delivery-bridge.py"),
).load_module()


class GitHubDeliveryBridgeTests(unittest.TestCase):
    def test_parses_standard_github_remotes(self):
        self.assertEqual(
            BRIDGE.github_repository("git@github.com:ivailo-iliev/class-schedule.git"),
            "ivailo-iliev/class-schedule",
        )
        self.assertEqual(
            BRIDGE.github_repository("https://github.com/ivailo-iliev/class-schedule"),
            "ivailo-iliev/class-schedule",
        )
        self.assertIsNone(BRIDGE.github_repository("https://example.test/owner/repo.git"))

    def test_recognizes_completion_contracts(self):
        self.assertEqual(BRIDGE.contract_repository("owner/repo"), "owner/repo")
        self.assertEqual(
            BRIDGE.contract_repository("https://github.com/owner/repo/pull/42"), "owner/repo",
        )
        self.assertTrue(BRIDGE.is_exact_pr("https://github.com/owner/repo/pull/42"))
        self.assertFalse(BRIDGE.is_exact_pr("owner/repo"))
        self.assertIsNone(BRIDGE.contract_repository("not a contract"))

    def test_only_review_tasks_with_matching_contract_are_publishable(self):
        task = BRIDGE.Task(
            id="t_deadbeef", title="Publish a change", status="review", branch_name="wt/t_deadbeef",
            workspace_path=None, completion_contract="owner/repo",
        )
        self.assertTrue(BRIDGE.publishable(task, "owner/repo"))
        self.assertFalse(BRIDGE.publishable(task, "other/repo"))
        self.assertFalse(BRIDGE.publishable(task.__class__(**{**task.__dict__, "status": "done"}), "owner/repo"))
        self.assertFalse(BRIDGE.publishable(task.__class__(**{**task.__dict__, "branch_name": "../bad"}), "owner/repo"))
