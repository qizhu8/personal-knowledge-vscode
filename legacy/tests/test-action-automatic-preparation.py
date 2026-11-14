import json
import platform
import socketserver
import os
import subprocess
import sys
import threading
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_modules import ModuleRuntime, object_schema
from action_runtime import ActionRuntime, register_action_tools


class AutomaticPreparationTests(unittest.TestCase):
    def fixture(self, directory):
        runtime = ModuleRuntime(Path(directory) / "store", proposal_mode=True)
        runtime.configure_workspace(str(Path(directory) / "workspace"))
        runtime.automatic_action_authority = lambda operation, *args, **kwargs: {
            "ok": True, "trusted": True, "trustEpoch": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
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

    def test_automatic_admission_and_call_require_live_exact_vscode_trust_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            del runtime.automatic_action_authority
            definition["effects"] = ["pure"]
            proposal = runtime.register(definition)
            attempt = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
            epoch = str(uuid.uuid4())
            token = "a" * 64

            class Authority(socketserver.ThreadingTCPServer):
                allow_reuse_address = True

            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    request = json.loads(self.rfile.readline())
                    trusted = (self.server.trusted and request.get("token") == token
                               and request.get("storePath") == str(runtime.store))
                    accepted_epoch = self.server.epoch
                    result = {"ok": trusted, "trusted": trusted, "trustEpoch": accepted_epoch,
                              **({} if trusted else {"reason": "WORKSPACE_NOT_TRUSTED"})}
                    if request.get("operation") == "authorize":
                        result["trusted"] = trusted and request.get("trustEpoch") == accepted_epoch
                        result["ok"] = result["trusted"]
                    self.wfile.write((json.dumps(result) + "\n").encode())

            authority = Authority(("127.0.0.1", 0), Handler)
            authority.trusted = True
            authority.epoch = epoch
            thread = threading.Thread(target=authority.serve_forever, daemon=True)
            thread.start()
            runtime.root.mkdir(parents=True, exist_ok=True)
            (runtime.root / "host-authority.json").write_text(json.dumps({
                "schema": "pkm.action.host-authority/v1", "host": "127.0.0.1",
                "port": authority.server_address[1], "token": token,
                "trust_epoch": epoch, "store_path": str(runtime.store),
            }))
            (runtime.root / "host-authority.json").chmod(0o600)
            try:
                self.assertEqual(runtime.automatic_action_authority("status")["trusted"], True)
                admitted = runtime.qualification_admit(attempt["attempt_id"], trust_epoch=epoch)
                self.assertTrue(admitted["ok"])
                run = runtime.call(definition["action_id"], {"value": "ready"}, "current-trust", proposal["content_hash"])
                self.assertEqual(runtime.wait(run["run_id"])["state"], "succeeded")

                authority.trusted = False
                with self.assertRaisesRegex(PermissionError, "current trusted VS Code workspace"):
                    runtime.call(definition["action_id"], {"value": "ready"}, "revoked-trust", proposal["content_hash"])
                authority.trusted = True
                authority.epoch = str(uuid.uuid4())
                with self.assertRaisesRegex(PermissionError, "current trusted VS Code workspace"):
                    runtime.call(definition["action_id"], {"value": "ready"}, "changed-epoch", proposal["content_hash"])
            finally:
                authority.shutdown()
                authority.server_close()
                thread.join(timeout=2)

    def test_production_mcp_registration_uses_live_vscode_authority_to_admit_and_call(self):
        scratch = Path(__file__).resolve().parent / ".action-trust-test-tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            store = Path(directory) / "store"
            runtime = ActionRuntime(store)
            runtime.modules.configure_workspace(str(Path(directory) / "workspace"))
            class FakeMcp:
                def __init__(self):
                    self.tools = {}
                def tool(self, **_):
                    return lambda function: self.tools.setdefault(function.__name__, function)

            mcp = FakeMcp()
            register_action_tools(mcp, store, runtime)
            env = {**os.environ, "PYTHON_EXECUTABLE": sys.executable}
            host = subprocess.Popen(
                ["node", "--experimental-strip-types", str(Path(__file__).resolve().parent / "action-trust-authority-host-fixture.mjs"), str(store)],
                cwd=Path(__file__).resolve().parents[1], env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                ready = json.loads(host.stdout.readline())
                self.assertTrue(ready["ready"])
                definition = {
                    "schema": "pkm.action.definition/v1", "action_id": "test.host.auto", "version": 1,
                    "description": "Trusted host route fixture",
                    "input_schema": object_schema({"value": {"type": "string"}}),
                    "output_schema": object_schema({"value": {"type": "string"}}),
                    "effects": ["pure"],
                    "implementations": [{"kind": "pipeline", "platforms": [platform.system()],
                                         "steps": [], "output": {"value": {"$input": "value"}}}],
                    "examples": [],
                }
                result = mcp.tools["action_register"](definition)
                self.assertEqual(result["state"], "automatically_admitted", result)
                self.assertTrue(result["registered"])
                self.assertTrue(result["callable"])
                run = mcp.tools["action_call"](result["action_id"], {"value": "immediate"},
                                               "trusted-create-call", result["content_hash"])
                completed = runtime.modules.wait(run["run_id"])
                self.assertEqual(completed["state"], "succeeded")
                self.assertEqual(completed["output"], {"value": "immediate"})
                grant = next(item for item in json.loads((runtime.root / "policy.json").read_text())["grants"]
                             if item["action_id"] == result["action_id"] and item["content_hash"] == result["content_hash"])
                self.assertEqual(grant["authorization_source"], "trusted_workspace_automatic")
                self.assertEqual(grant["trust_epoch"], ready["trustEpoch"])
                effectful_definition = {**definition, "action_id": "test.host.effectful",
                                        "effects": ["remote-read"]}
                effectful = mcp.tools["action_register"](effectful_definition)
                self.assertEqual(effectful["state"], "automatically_admitted")
                with self.assertRaisesRegex(PermissionError, "did not approve this exact Action invocation"):
                    mcp.tools["action_call"](effectful["action_id"], {"value": "blocked"},
                                             "effect-consent-denied", effectful["content_hash"])
                host.stdin.write("allow-effects\n")
                host.stdin.flush()
                effectful_run = mcp.tools["action_call"](
                    effectful["action_id"], {"value": "allowed"}, "effect-consent-allowed",
                    effectful["content_hash"])
                effectful_completed = runtime.modules.wait(effectful_run["run_id"])
                self.assertEqual(effectful_completed["state"], "succeeded")
                self.assertEqual(effectful_completed["output"], {"value": "allowed"})
                host.stdin.write("revoke\n")
                host.stdin.flush()
                with self.assertRaisesRegex(PermissionError, "current trusted VS Code workspace"):
                    mcp.tools["action_call"](result["action_id"], {"value": "blocked"},
                                             "after-revocation", result["content_hash"])
            finally:
                host.terminate()
                try:
                    host.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    host.kill()
                    host.wait(timeout=5)
                if host.stdin:
                    host.stdin.close()
                if host.stdout:
                    host.stdout.close()
                if host.stderr:
                    host.stderr.close()

    def test_create_prepare_ready_survives_restart_without_model_consent_or_effectful_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, definition = self.fixture(directory)
            proposal = runtime.register(definition)
            self.assertEqual(len(runtime.catalog()["proposals"]), 1)
            with patch.object(ModuleRuntime, "call", side_effect=AssertionError("effectful example ran")):
                prepared = runtime.qualification_prepare(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
                self.assertEqual(prepared["state"], "environment_checked")
                admitted = runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            self.assertEqual(admitted["state"], "succeeded")
            restored = ModuleRuntime(runtime.store)
            restored.automatic_action_authority = runtime.automatic_action_authority
            self.assertEqual(restored.availability(definition["action_id"])["state"], "ready")
            self.assertEqual(restored.proposal_list()["proposals"], [])
            report = json.loads((runtime.root / "code-reviews" / (definition["action_id"] + ".json")).read_text())
            self.assertEqual(report["mode"], "automatic")
            self.assertFalse(report["user_confirmed"], "automatic readiness must not fabricate human confirmation")
            self.assertEqual(report["model"], "pkm:automatic-readiness")
            usable = {**definition, "action_id": "test.automatic.usable", "effects": ["pure"], "examples": []}
            usable_proposal = restored.register(usable)
            usable_attempt = restored.qualification_prepare(usable_proposal["action_id"], usable_proposal["content_hash"])
            restored.qualification_admit(usable_attempt["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            run = restored.call(usable["action_id"], {"value": "ready"}, "without-gpt-review",
                                usable_proposal["content_hash"])
            completed = restored.wait(run["run_id"])
            self.assertEqual(completed["state"], "succeeded")
            self.assertEqual(completed["output"], {"value": "ready"})

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
            runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
            runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
            runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
                runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
            runtime.qualification_admit(prepared["attempt_id"], trust_epoch="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
