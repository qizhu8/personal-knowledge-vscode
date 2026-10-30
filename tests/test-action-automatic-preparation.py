import json
import platform
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_modules import ModuleRuntime, object_schema


class AutomaticPreparationTests(unittest.TestCase):
    def fixture(self, directory):
        runtime = ModuleRuntime(Path(directory) / "store", proposal_mode=True)
        runtime.configure_workspace(str(Path(directory) / "workspace"))
        definition = {
            "schema": "pkm.action.definition/v1", "action_id": "test.automatic", "version": 1,
            "description": "Automatic preparation fixture",
            "input_schema": object_schema({"value": {"type": "string"}}),
            "output_schema": object_schema({"value": {"type": "string"}}),
            "effects": ["remote-read"],
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()],
                                 "steps": [], "output": {"value": {"$input": "value"}}}],
            "examples": [{"inputs": {"value": "must not run"}}],
        }
        return runtime, definition

    def test_create_prepare_ready_survives_restart_without_model_consent_or_effectful_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            proposal = runtime.register(definition)
            self.assertEqual(len(runtime.catalog()["proposals"]), 1)
            with patch.object(ModuleRuntime, "call", side_effect=AssertionError("effectful example ran")):
                prepared = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
                self.assertEqual(prepared["state"], "environment_checked")
                admitted = runtime.qualification_admit(prepared["attempt_id"])
            self.assertEqual(admitted["state"], "succeeded")
            restored = ModuleRuntime(runtime.store)
            self.assertEqual(restored.availability(definition["action_id"])["state"], "ready")
            self.assertEqual(restored.proposal_list()["proposals"], [])
            report = json.loads((runtime.root / "code-reviews" / (definition["action_id"] + ".json")).read_text())
            self.assertEqual(report["mode"], "automatic")
            self.assertFalse(report["user_confirmed"], "automatic readiness must not fabricate human confirmation")
            self.assertEqual(report["model"], "pkm:automatic-readiness")

    def test_arbitrary_program_is_not_run_even_when_declared_pure(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            marker = Path(directory) / "unexpected-execution"
            source = Path(directory) / "implementation.py"
            source.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n")
            definition["effects"] = ["pure"]
            definition["implementations"] = [{"kind": "program", "platforms": [platform.system()],
                                              "program": sys.executable, "args": [str(source)], "files": [str(source)]}]
            proposal = runtime.register(definition)
            prepared = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            runtime.qualification_admit(prepared["attempt_id"])
            self.assertFalse(marker.exists())
            self.assertEqual(runtime.availability(definition["action_id"])["state"], "ready")

    def test_pending_folder_and_language_metadata_persist_through_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            proposal = runtime.register(definition)
            runtime.group_create("Tools")
            runtime.group_create("Cloud", "Tools")
            runtime.action_move(proposal["action_id"], "Tools/Cloud")
            restored = ModuleRuntime(runtime.store)
            pending = restored.catalog()["proposals"][0]
            self.assertEqual((pending["category"], pending["language"]), ("Tools/Cloud", "Graph"))
            self.assertEqual(pending["content_hash"], proposal["content_hash"])
            prepared = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            runtime.qualification_admit(prepared["attempt_id"])
            action = next(item for item in restored.catalog()["actions"] if item["action_id"] == proposal["action_id"])
            self.assertEqual((action["category"], action["language"]), ("Tools/Cloud", "Graph"))
            runtime.host_trust_update(action["action_id"], action["content_hash"],
                                      runtime.host_trust_review(action["action_id"], action["content_hash"])["review_hash"], False)
            pending_admission = restored.catalog()["pending_admissions"][0]
            self.assertEqual((pending_admission["category"], pending_admission["language"]), ("Tools/Cloud", "Graph"))
            with self.assertRaises(FileNotFoundError):
                runtime.action_move("test.missing", "Tools")
            with self.assertRaises(PermissionError):
                runtime.action_move("core.constant", "Tools")

    def test_changed_source_blocks_admission_and_preserves_old_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            first = runtime.register(definition)
            prepared = runtime.qualification_prepare(first["action_id"], first["content_hash"], first["proposal_id"])
            runtime.qualification_admit(prepared["attempt_id"])
            definition["version"] = 2
            definition["description"] = "Updated implementation"
            source = Path(directory) / "implementation.py"
            source.write_text("print('first')\n")
            definition["implementations"] = [{"kind": "program", "platforms": [platform.system()],
                                              "program": sys.executable, "args": [str(source)], "files": [str(source)]}]
            second = runtime.register(definition)
            prepared = runtime.qualification_prepare(second["action_id"], second["content_hash"], second["proposal_id"])
            source.write_text("print('changed')\n")
            with self.assertRaises((ValueError, PermissionError)):
                runtime.qualification_admit(prepared["attempt_id"])
            self.assertEqual(runtime.definition(first["action_id"])["version"], 1)
            self.assertEqual(runtime.availability(first["action_id"])["state"], "ready")
            self.assertEqual(len(runtime.proposal_list()["proposals"]), 1)

    def test_missing_runtime_remains_blocked_with_durable_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            definition["implementations"] = [{"kind": "program", "platforms": [platform.system()],
                                              "program": "pkm-nonexistent-fixture-runtime"}]
            proposal = runtime.register(definition)
            with self.assertRaises((ValueError, PermissionError)):
                runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            restored = ModuleRuntime(runtime.store)
            pending = restored.catalog()["proposals"][0]
            self.assertEqual(pending["preparation"]["state"], "blocked")
            self.assertTrue(pending["preparation"]["reason"])
            self.assertNotIn(definition["action_id"], [action["action_id"] for action in restored.catalog()["actions"]])

    def test_explicit_revocation_is_not_undone_by_background_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            proposal = runtime.register(definition)
            prepared = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            runtime.qualification_admit(prepared["attempt_id"])
            review = runtime.host_trust_review(proposal["action_id"], proposal["content_hash"])
            runtime.host_trust_update(proposal["action_id"], proposal["content_hash"], review["review_hash"], False)
            for _ in range(2):
                with self.assertRaisesRegex(PermissionError, "explicitly revoked"):
                    runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"])
            self.assertFalse(runtime.admitted(runtime.definition(proposal["action_id"])))
            pending = runtime.catalog()["pending_admissions"][0]
            self.assertEqual(pending["preparation"]["state"], "disabled")

    def test_pure_example_failure_never_admits_the_action(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            definition["effects"] = ["pure"]
            definition["examples"] = [{"inputs": {"value": "actual"}, "output": {"value": "wrong"}}]
            proposal = runtime.register(definition)
            with self.assertRaisesRegex(ValueError, "Smoke tests failed"):
                runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            self.assertFalse((runtime.registry / (proposal["action_id"] + ".json")).exists())
            self.assertEqual(runtime.catalog()["proposals"][0]["preparation"]["state"], "blocked")


if __name__ == "__main__":
    unittest.main()
