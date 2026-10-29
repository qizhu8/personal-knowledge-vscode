"""Durable Component observations against isolated real worker Runs."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("recovery_fixture", Path(__file__).with_name("test-action-recovery-e2e.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ComponentEvents(fixture.RecoveryE2E):
    def events(self, run_id):
        folder = self.runtime.path(run_id).parent / "step-events"
        return {value["key"]: value for file in folder.glob("*.json")
                for value in [json.loads(file.read_text(encoding="utf-8"))]}

    def test_branch_records_executed_and_ignored_without_executing_skipped_effect(self):
        definition = self.ready(self.pipeline("fixture.events.branch", [{
            "id": "branch", "component": "core.if-else", "inputs": {
                "condition": True,
                "then_steps": [{"id": "selected", "component": "core.constant", "inputs": {"value": "yes"}}],
                "else_steps": [{"id": "ignored", "component": "core.constant", "inputs": {"value": "no"}}],
                "then_value": "yes", "else_value": "no"}}]))
        run = self.call(definition)
        result = self.state(run["run_id"], {"succeeded"})
        self.assertEqual(result["output"], {"value": "yes"})
        events = self.events(run["run_id"])
        self.assertEqual(events["branch"]["state"], "completed")
        self.assertEqual([item["state"] for item in events["branch"]["events"]], ["running", "completed"])
        self.assertEqual(events["branch/then/selected"]["state"], "completed")
        self.assertEqual(events["branch/else/ignored"]["state"], "ignored")
        self.assertIn("not executed", events["branch/else/ignored"]["events"][0]["reason"])
        receipts = self.runtime.path(run["run_id"]).parent / "steps"
        self.assertFalse(any(json.loads(file.read_text())["key"] == "branch/else/ignored" for file in receipts.glob("*.json")))

    def test_waiting_resume_preserves_events_and_completed_step_is_not_replayed(self):
        definition = self.checkpoint_definition()
        run = self.call(definition)
        waiting = self.state(run["run_id"], {"waiting"})
        before = self.events(run["run_id"])["review"]
        self.assertEqual([event["state"] for event in before["events"]], ["running", "waiting"])
        self.answer(waiting["checkpoint"], {"approved": True})
        self.state(run["run_id"], {"succeeded"})
        after = self.events(run["run_id"])["review"]
        self.assertEqual(after["events"][:2], before["events"])
        self.assertEqual(after["events"][-1]["state"], "completed")
        reused = self.call(definition)
        self.assertEqual(reused["run_id"], run["run_id"])
        self.assertEqual(self.events(run["run_id"])["review"], after)


if __name__ == "__main__":
    unittest.main()
