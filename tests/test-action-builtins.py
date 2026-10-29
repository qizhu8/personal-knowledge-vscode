"""Preinstalled Actions use real isolated workers and durable checkpoint receipts."""

import asyncio
import json
import platform
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_modules import COPY_FIXTURE_ARTIFACT, ModuleRuntime, builtin_definitions
from action_runtime import ActionRuntime, register_action_tools
from fastmcp import Client, FastMCP
from jsonschema import ValidationError


class Builtins(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-action-builtins-")
        self.addCleanup(self.temporary.cleanup)
        self.runtime = ModuleRuntime(Path(self.temporary.name) / "store")
        self.runtime.configure_workspace(self.temporary.name)

    def state(self, run_id, states, timeout=20):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            self.runtime.recovery.safety_scan()
            result = self.runtime.get(run_id)
            if result["state"] in states:
                return result
            time.sleep(0.025)
        self.fail(str(result))

    def launch(self, action_id, inputs, key="once"):
        definition = self.runtime.definition(action_id)
        return self.runtime.call(action_id, inputs, key, definition["content_hash"])

    def test_timer_thresholds_cancel_and_same_run_after_new_api_process(self):
        for seconds in [30, 300]:
            with self.subTest(seconds=seconds):
                run = self.launch("core.delay", {"seconds": seconds}, str(seconds))
                waiting = self.state(run["run_id"], {"waiting"})
                checkpoint = waiting["checkpoint"]
                self.assertAlmostEqual(checkpoint["trigger"]["at"] - checkpoint["created_at"], seconds, delta=0.2)
                self.assertIsNone(waiting["execution"]["workerPid"])
                process = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] /
                    "resources/action_modules.py"), "--api", str(self.runtime.store)],
                    input=json.dumps({"method": "run", "params": {"run_id": run["run_id"]}}),
                    text=True, capture_output=True, timeout=30)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(json.loads(process.stdout)["run_id"], run["run_id"])
                self.assertEqual(self.launch("core.delay", {"seconds": seconds}, str(seconds))["run_id"], run["run_id"])
                self.runtime.cancel(run["run_id"])
                self.assertEqual(self.runtime.get(run["run_id"])["state"], "cancelled")
        run = self.launch("core.delay", {"seconds": 0.2}, "short")
        completed = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["output"], {"seconds": 0.2})

    def test_alias_requires_real_answer_and_rejects_invalid_or_stale(self):
        run = self.launch("core.chatroom-alias", {"room": "isolated room"})
        waiting = self.state(run["run_id"], {"waiting"})
        checkpoint = waiting["checkpoint"]
        with self.assertRaises(ValidationError):
            self.runtime.recovery.check_checkpoint_answer(run["run_id"], checkpoint["checkpoint_id"], {"alias": " "})
        self.assertEqual(self.runtime.get(run["run_id"])["state"], "waiting")
        self.runtime.recovery.check_checkpoint_answer(run["run_id"], checkpoint["checkpoint_id"], {"alias": "research-agent"})
        self.runtime.recovery.respond_checkpoint(run["run_id"], checkpoint["checkpoint_id"],
            checkpoint["resume_token"], checkpoint["proposal_digest"], {"alias": "research-agent"}, "answer")
        completed = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["output"], {"value": {"alias": "research-agent"}})
        with self.assertRaises(ValueError):
            self.runtime.recovery.check_checkpoint_answer(run["run_id"], checkpoint["checkpoint_id"], {"alias": "other"})

    def query(self):
        return self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "fixture.query", "version": 1,
            "description": "Read-only fixture", "effects": ["pure"], "dependencies": {},
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
            "output_schema": {"type": "object", "properties": {"status": {"type": "string"}}, "required": ["status"]},
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()],
                "steps": [{"id": "value", "component": "core.constant", "inputs": {"value": "running"}}],
                "output": {"status": {"$step": "value.value"}}}],
            "examples": [{"inputs": {}, "output": {"status": "running"}}]})

    def poll(self, expected, timeout=0.4):
        query = self.query()
        self.assertTrue(self.runtime.validate(query["action_id"], query["content_hash"])["ok"])
        return self.runtime.template_create("fixture.poll", {"query_action_id": query["action_id"],
            "query_revision": query["content_hash"], "query_inputs": {}, "field": "status", "expected": expected,
            "interval_seconds": 0.1, "timeout_seconds": timeout, "max_iterations": 3})

    def test_poll_success(self):
        definition = self.poll("running", 5)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        run = self.launch(definition["action_id"], {})
        completed = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["output"], {"status": "completed", "attempts": 1, "value": "running"})

    def test_poll_timeout_and_replay_receipts_across_api_restart(self):
        definition = self.poll("finished", 10)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        run = self.launch(definition["action_id"], {})
        result = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(result["state"], "succeeded", result)
        self.assertEqual(result["output"], {"status": "timed_out", "attempts": 3, "value": "running"})
        children = [json.loads(path.read_text()) for path in (self.runtime.root / "runs").glob("*/run.json")]
        children = [child for child in children if child.get("parent_run_id") == run["run_id"]]
        self.assertEqual(len(children), 3)
        self.assertEqual(len({child["run_id"] for child in children}), 3)
        reloaded = ModuleRuntime(self.runtime.store)
        self.assertEqual(reloaded.get(run["run_id"])["output"], result["output"])
        self.assertEqual(self.launch(definition["action_id"], {})["run_id"], run["run_id"])

    def test_poll_wall_timeout_and_input_validation(self):
        definition = self.poll("finished", 0.02)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        run = self.launch(definition["action_id"], {})
        result = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(result["output"]["status"], "timed_out", result)
        self.assertLessEqual(result["output"]["attempts"], 1)
        parameters = {"query_action_id": "fixture.query", "query_revision": "stale", "query_inputs": {},
            "field": "status", "expected": True, "interval_seconds": 1, "timeout_seconds": 5, "max_iterations": 3}
        with self.assertRaises(PermissionError):
            self.runtime.template_create("fixture.badpoll", parameters)
        with self.assertRaises(ValueError):
            self.runtime.template_create("fixture.badpoll", {})
        mutation = self.runtime.definition("core.artifact.write")
        with self.assertRaises(PermissionError):
            self.runtime.template_create("fixture.mutatingpoll", {**parameters,
                "query_action_id": mutation["action_id"], "query_revision": mutation["content_hash"]})

    def test_poll_timeout_cancels_a_still_waiting_read_query(self):
        slow = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "fixture.slow", "version": 1,
            "description": "Isolated slow read fixture", "effects": ["pure"], "dependencies": {},
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
            "output_schema": {"type": "object", "properties": {"status": {"type": "string"}}, "required": ["status"]},
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()],
                "steps": [{"id": "delay", "component": "core.sleep", "inputs": {"seconds": 5}},
                          {"id": "value", "component": "core.constant", "inputs": {"value": "done"}}],
                "output": {"status": {"$step": "value.value"}}}], "examples": [{"inputs": {}}]})
        self.assertTrue(self.runtime.validate(slow["action_id"], slow["content_hash"])["ok"])
        definition = self.runtime.template_create("fixture.slowpoll", {"query_action_id": slow["action_id"],
            "query_revision": slow["content_hash"], "query_inputs": {}, "field": "status", "expected": "done",
            "interval_seconds": 0.1, "timeout_seconds": 1.5, "max_iterations": 3})
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        before = time.monotonic()
        run = self.launch(definition["action_id"], {})
        completed = self.state(run["run_id"], {"succeeded", "failed", "outcome_unknown"})
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["output"], {"status": "timed_out", "attempts": 1, "value": None})
        self.assertLess(time.monotonic() - before, 4.5)
        children = [json.loads(path.read_text()) for path in (self.runtime.root / "runs").glob("*/run.json")]
        children = [child for child in children if child.get("parent_run_id") == run["run_id"]]
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["state"], "cancelled")

    def test_builtin_review_includes_runtime_source_and_copy_qualifies_with_staged_fixture(self):
        report = {"user_confirmed": True, "summary": "Bundled host handlers.", "issues": [], "model": "fixture"}
        for action_id, handler in (("core.artifact.copy", "ModuleRuntime._execute"),
                                   ("core.delay", "action_components.execute_steps")):
            definition = self.runtime.definition(action_id)
            review = self.runtime.qualification_review(action_id, definition["content_hash"])
            self.assertEqual(review["validation_kind"], "environment-self-test")
            self.assertTrue(any(name.endswith(handler) and source.strip() for name, source in review["sources"].items()))
        definition = self.runtime.definition("core.artifact.copy")
        review = self.runtime.qualification_review("core.artifact.copy", definition["content_hash"])
        tested = self.runtime.qualification_execute("core.artifact.copy", definition["content_hash"],
                                                    review["snapshot_hash"], report, allow_effects=True)
        self.assertTrue(self.runtime.qualification_admit(tested["attempt_id"])["ok"])
        self.assertFalse(self.runtime.artifact_path(COPY_FIXTURE_ARTIFACT).exists())

    def test_every_bundled_core_passes_environment_qualification(self):
        report = {"user_confirmed": True, "summary": "Controlled environment test.",
                  "issues": [], "model": "pkm:environment-self-test"}
        for action_id in builtin_definitions():
            with self.subTest(action_id=action_id):
                definition = self.runtime.definition(action_id)
                review = self.runtime.qualification_review(action_id, definition["content_hash"])
                self.assertEqual(review["validation_kind"], "environment-self-test")
                attempt = self.runtime.qualification_execute(action_id, definition["content_hash"],
                    review["snapshot_hash"], report, allow_effects=True)
                self.runtime.qualification_admit(attempt["attempt_id"])
                self.assertEqual(self.runtime.availability(action_id)["state"], "ready")

    def test_artifact_read_rejects_changed_content_oversize_and_symlink(self):
        source = Path(self.temporary.name) / "source.txt"
        source.write_text("fixture")
        reference = self.runtime.import_artifact(str(source))
        metadata = self.runtime.artifact(reference["artifact_id"])
        self.assertEqual(self.runtime.artifact_content(metadata), b"fixture")
        source.write_text("changed")
        with self.assertRaisesRegex(ValueError, "digest changed"):
            self.runtime.artifact_content(metadata)
        with source.open("wb") as handle:
            handle.truncate(64 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "64 MiB"):
            self.runtime.artifact_content(metadata)
        source.unlink()
        source.symlink_to(Path(self.temporary.name) / "other.txt")
        with self.assertRaises(PermissionError):
            self.runtime.artifact_content(metadata)

    def test_mcp_auto_timer_and_bounded_wait_return_original_run(self):
        async def exercise():
            runtime = ActionRuntime(self.runtime.store)
            server = FastMCP("action-builtins-fixture")
            register_action_tools(server, self.runtime.store, runtime)
            async with Client(server) as client:
                templates = (await client.call_tool("action_templates", {})).structured_content
                self.assertTrue(any(item["action_id"] == "core.delay" for item in templates["templates"] if "action_id" in item))
                definition = runtime.definition("core.delay")
                run = (await client.call_tool("action_call", {"action_id": "core.delay", "inputs": {"seconds": 1},
                    "content_hash": definition["content_hash"], "idempotency_key": "mcp"})).structured_content
                partial = (await client.call_tool("action_run_wait", {"run_id": run["run_id"], "wait_seconds": 0})).structured_content
                self.assertTrue(partial["wait_expired"])
                await asyncio.sleep(3)
                result = runtime.get(run["run_id"])
                self.assertEqual(result["state"], "succeeded", result)
                self.assertEqual(result["run_id"], run["run_id"])
                scheduler = runtime._scheduler
                if scheduler:
                    scheduler.join(timeout=5)
                    self.assertFalse(scheduler.is_alive(), "Fixture scheduler must stop before its temporary store is removed")
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
