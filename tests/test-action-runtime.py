import asyncio
import datetime
import json
import importlib.util
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_runtime import ActionRuntime, cosmos_location, register_action_tools
from fastmcp import Client, FastMCP

runner_spec = importlib.util.spec_from_file_location("cosmos_action_upload_runner", Path(__file__).resolve().parents[1] / "scripts" / "run-cosmos-action-upload.py")
upload_runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(upload_runner)


URI = "https://cosmos.example.invalid/cosmos/fixture.vc/shares/fixture.vc/fixtures"


class ActionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        program = self.directory / "mock-az"
        program.write_text("#!/usr/bin/env python3\nimport json, sys, time\nif any('slow.txt' in arg for arg in sys.argv): time.sleep(10)\nprint(json.dumps({'argv':sys.argv[1:]}))\n", encoding="utf-8")
        program.chmod(0o700)
        self.runtime = ActionRuntime(self.directory, str(program))
        self.runtime.root.mkdir(parents=True)
        self.runtime.configure_cosmos([{"host": "cosmos.example.invalid", "vc": "fixture.vc", "account": "fixture-adl"}])
        (self.runtime.root / "policy.json").write_text(json.dumps({
            "schema": "pkm.action.policy/v1",
            "grants": [{"action_id": action_id, "remote_root": URI, "local_root": str(self.directory)}
                       for action_id in ["cosmos.artifact.upload", "cosmos.artifact.download", "cosmos.directory.list"]],
        }), encoding="utf-8")
        validations = self.runtime.root / "validations"
        validations.mkdir()
        for action_id in ["cosmos.artifact.upload", "cosmos.artifact.download", "cosmos.directory.list"]:
            (validations / (action_id + ".json")).write_text(json.dumps({
                "schema": "pkm.action.validation/v1", "action_id": action_id, "kind": "smoke", "status": "passed",
                "content_hash": self.runtime.definition(action_id)["content_hash"],
                "environment_fingerprint": self.runtime.environment_fingerprint(),
                "expires_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat(),
            }), encoding="utf-8")

    def wait(self, run_id):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            record = self.runtime.get(run_id)
            if record["state"] != "running":
                return record
            time.sleep(0.05)
        self.runtime.cancel(run_id)
        self.fail("Action worker did not complete")

    def call(self, action_id, inputs, key):
        return self.runtime.call(action_id, inputs, key, self.runtime.definition(action_id)["content_hash"])

    def test_discovery(self):
        self.assertEqual(self.runtime.retrieve("cosmos artifact upload")["selected_action_id"], "cosmos.artifact.upload")
        self.assertTrue(self.runtime.retrieve("cosmos")["ambiguous"])
        self.assertIsNone(self.runtime.retrieve("cosmos")["selected_action_id"])
        self.assertTrue(self.runtime.retrieve("unmatchedzzzz")["no_match"])
        self.assertEqual(cosmos_location(URI, self.runtime.cosmos_accounts())["account"], "fixture-adl")

    def test_call_and_idempotency(self):
        source = self.directory / "file with spaces.txt"
        source.write_text("non-private fixture", encoding="utf-8")
        inputs = {"uri": URI + "/test/file.txt", "local_path": str(source)}
        first = self.call("cosmos.artifact.upload", inputs, "upload-once")
        result = self.wait(first["run_id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(self.runtime.list_runs()["runs"][0]["run_id"], first["run_id"])
        self.assertEqual(self.runtime.list_runs()["runs"][0]["state"], "succeeded")
        self.assertEqual(result["output"]["argv"][0:3], ["dls", "fs", "upload"])
        self.assertIn(str(source), result["output"]["argv"])
        self.assertNotIn("--overwrite", result["output"]["argv"])
        self.assertEqual(self.call("cosmos.artifact.upload", inputs, "upload-once")["run_id"], first["run_id"])
        with self.assertRaises(ValueError):
            self.call("cosmos.artifact.upload", {**inputs, "uri": URI + "/different"}, "upload-once")
        self.assertEqual(len(list((self.runtime.root / "runs").iterdir())), 1)

    def test_scope_and_schema(self):
        for uri in [URI + "-outside", URI + "/%2e%2e/outside"]:
            with self.assertRaises((PermissionError, ValueError)):
                self.call("cosmos.directory.list", {"uri": uri}, "invalid-uri")
        with self.assertRaises(ValueError):
            self.call("cosmos.artifact.download", {"uri": URI, "local_path": str(self.directory / "out"), "overwrite": "false"}, "invalid-boolean")
        with self.assertRaises(PermissionError):
            self.call("cosmos.artifact.download", {"uri": URI, "local_path": "/tmp/outside-action"}, "invalid-local")
        with self.assertRaises(ValueError):
            self.runtime.get("../../private")
        with self.assertRaises(ValueError):
            self.runtime.call("cosmos.directory.list", {"uri": URI}, "old-hash", "obsolete")
        self.assertFalse((self.runtime.root / "runs").exists())

    def test_large_transfer_timeout_and_bounded_threads(self):
        source = self.directory / "large-transfer.txt"
        source.write_text("fixture", encoding="utf-8")
        inputs = {"uri": URI + "/large-transfer.txt", "local_path": str(source), "timeout_seconds": 7200, "thread_count": 8}
        record = self.call("cosmos.artifact.upload", inputs, "large-transfer")
        spec = json.loads((self.runtime.root / "runs" / record["run_id"] / "spec.json").read_text())
        self.assertEqual(spec["timeoutSeconds"], 7200)
        result = self.wait(record["run_id"])
        self.assertEqual(result["state"], "succeeded")
        arguments = result["output"]["argv"]
        self.assertEqual(arguments[arguments.index("--thread-count") + 1], "8")
        self.assertNotIn("--overwrite", arguments)
        for field, values in {"timeout_seconds": [0, 86401, True, "7200"], "thread_count": [0, 33, False, "8"]}.items():
            for value in values:
                with self.assertRaises(ValueError):
                    self.call("cosmos.artifact.upload", {**inputs, field: value}, "invalid-large-transfer")

    def test_cancel(self):
        source = self.directory / "slow.txt"
        source.write_text("fixture", encoding="utf-8")
        record = self.call("cosmos.artifact.upload", {"uri": URI + "/slow", "local_path": str(source)}, "cancel-test")
        self.assertTrue(self.runtime.cancel(record["run_id"])["cancel_requested"])
        result = self.wait(record["run_id"])
        self.assertEqual(result["state"], "outcome_unknown")
        self.assertFalse(result["ok"])

    def test_validation_gate(self):
        action_id = "cosmos.directory.list"
        unavailable = ActionRuntime(self.directory, str(self.directory / "missing-az"))
        self.assertEqual(unavailable.availability(action_id)["state"], "blocked")
        self.assertEqual(unavailable.definition(action_id)["content_hash"],
                         self.runtime.definition(action_id)["content_hash"])
        path = self.runtime.root / "validations" / (action_id + ".json")
        original = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(self.runtime.availability(action_id)["state"], "ready")
        for field, value in [("content_hash", "changed"), ("environment_fingerprint", "windows-unverified"),
                             ("expires_at", "2000-01-01T00:00:00+00:00"), ("expires_at", "malformed")]:
            path.write_text(json.dumps({**original, field: value}), encoding="utf-8")
            self.assertEqual(self.runtime.availability(action_id)["state"], "stale")
            with self.assertRaises(PermissionError):
                self.call(action_id, {"uri": URI}, "not-validated")
        path.unlink()
        self.assertEqual(self.runtime.availability(action_id)["state"], "unverified")
        self.assertIsNone(self.runtime.retrieve("cosmos directory list")["selected_action_id"])
        self.assertFalse((self.runtime.root / "runs").exists())

    def test_actual_qualification_requires_authorized_roundtrip(self):
        action = "cosmos.artifact.upload"
        validation = self.runtime.root / "validations" / (action + ".json")
        validation.unlink()
        self.runtime.modules.configure_workspace(str(self.directory / "workspace"))
        source = self.directory / "qualification.txt"
        source.write_text("approved fixture", encoding="utf-8")
        inputs = {"uri": URI + "/qualification.txt", "local_path": str(source)}
        self.assertEqual(self.runtime.availability(action)["state"], "unverified")
        with self.assertRaises(PermissionError):
            self.call(action, inputs, "before-proof")

        def verify(command, **kwargs):
            destination = Path(command[command.index("--destination-path") + 1])
            destination.write_bytes(source.read_bytes())
            return type("Verified", (), {"returncode": 0})()

        with patch("action_runtime.subprocess.run", side_effect=verify):
            proof = self.runtime.validate(action, self.runtime.definition(action)["content_hash"], inputs)
        self.assertTrue(proof["ok"])
        self.assertEqual(self.runtime.availability(action)["state"], "ready")
        self.assertEqual(self.runtime.get(proof["proof"]["run_id"])["state"], "succeeded")
        validation.unlink()
        with patch("action_runtime.subprocess.run", return_value=type("Failed", (), {"returncode": 1})()):
            with self.assertRaisesRegex(RuntimeError, "read-back"):
                self.runtime.validate(action, self.runtime.definition(action)["content_hash"], {**inputs, "uri": URI + "/failed-proof.txt"})
        self.assertFalse(validation.exists())
        with self.assertRaises((ValueError, PermissionError)):
            self.runtime.validate(action, self.runtime.definition(action)["content_hash"], {**inputs, "overwrite": True})

    def test_operator_policy_is_explicit_and_preserves_grants(self):
        grant = {"action_id": "cosmos.artifact.upload", "remote_root": URI + "/models", "local_root": str(self.directory), "allow_overwrite": False}
        self.assertTrue(self.runtime.configure_policy([grant])["ok"])
        self.runtime.configure_policy([grant])
        policy = json.loads((self.runtime.root / "policy.json").read_text())
        self.assertEqual(len(policy["grants"]), 4)
        with self.assertRaises(ValueError):
            self.runtime.configure_policy([{**grant, "allow_overwrite": "true"}])

    def test_cosmos_is_not_a_default_action(self):
        clean = ActionRuntime(self.directory / "clean", self.runtime.program)
        self.assertEqual(clean.enabled_platform_actions(), [])
        self.assertEqual(clean.retrieve("cosmos upload", 10)["candidates"], [])
        self.assertIn("cosmos.artifact.upload", self.runtime.enabled_platform_actions())
        definition = self.runtime.definition("cosmos.artifact.upload")
        self.assertEqual(definition["visibility"], "private")
        self.assertFalse(definition["exportable"])
        with self.assertRaises(FileNotFoundError):
            self.runtime.modules.definition("cosmos.artifact.upload")

    def test_private_bindings_are_explicit_and_do_not_retarget_existing_grants(self):
        self.assertEqual((self.runtime.root / "cosmos-bindings.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            cosmos_location(URI)
        with self.assertRaises(PermissionError):
            self.runtime.configure_cosmos([{"host": "cosmos.example.invalid", "vc": "fixture.vc", "account": "different-account"}])
        self.assertEqual(self.runtime.cosmos_accounts()[("cosmos.example.invalid", "fixture.vc")], "fixture-adl")

    def test_file_and_folder_roundtrip_with_real_cli_adapter_and_separate_download_qualification(self):
        remote = self.directory / "fake-cloud"
        remote.mkdir()
        program = self.directory / "roundtrip-az"
        program.write_text("#!" + sys.executable + "\n" + """
import json, shutil, sys
from pathlib import Path
args=sys.argv[1:]
def option(key): return args[args.index(key)+1]
remote=Path(""" + repr(str(remote)) + """)
operation=args[2]
if operation=='list':
    print('[]'); raise SystemExit(0)
source=Path(option('--source-path'))
destination=Path(option('--destination-path'))
if operation=='upload': destination=remote/str(destination).lstrip('/')
else: source=remote/str(source).lstrip('/')
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists() and '--overwrite' not in args: raise SystemExit(2)
if source.is_dir(): shutil.copytree(source,destination,dirs_exist_ok='--overwrite' in args)
else: shutil.copyfile(source,destination)
print('null')
""", encoding="utf-8")
        program.chmod(0o700)
        self.runtime.program = str(program)
        self.runtime.modules.configure_workspace(str(self.directory))
        source = self.directory / "approved-fixture.bin"
        source.write_bytes(b"\x00fixture\xff")
        uploaded_uri = URI + "/qualification.bin"
        result = self.runtime.validate("cosmos.artifact.upload", self.runtime.definition("cosmos.artifact.upload")["content_hash"],
            {"uri": uploaded_uri, "local_path": str(source)})
        self.assertTrue(result["ok"])
        downloaded_fixture = self.directory / "qualified-download.bin"
        result = self.runtime.validate("cosmos.artifact.download", self.runtime.definition("cosmos.artifact.download")["content_hash"],
            {"uri": uploaded_uri, "local_path": str(downloaded_fixture)})
        self.assertTrue(result["ok"])
        self.assertEqual(downloaded_fixture.read_bytes(), source.read_bytes())
        directory = self.directory / "folder"
        (directory / "nested").mkdir(parents=True)
        (directory / "alpha.txt").write_text("alpha")
        (directory / "nested" / "beta.bin").write_bytes(b"\x00\x01\xff")
        uploaded = self.wait(self.call("cosmos.artifact.upload", {"uri": URI + "/folder", "local_path": str(directory)}, "directory-upload")["run_id"])
        self.assertEqual(uploaded["state"], "succeeded", uploaded)
        destination = self.directory / "downloaded-folder"
        downloaded = self.wait(self.call("cosmos.artifact.download", {"uri": URI + "/folder", "local_path": str(destination)}, "directory-download")["run_id"])
        self.assertEqual(downloaded["state"], "succeeded", downloaded)
        self.assertEqual((destination / "alpha.txt").read_text(), "alpha")
        self.assertEqual((destination / "nested" / "beta.bin").read_bytes(), b"\x00\x01\xff")
        with self.assertRaises(FileExistsError):
            self.call("cosmos.artifact.download", {"uri": URI + "/folder", "local_path": str(destination)}, "no-overwrite")

    def test_file_scoped_batch_verifies_manifest(self):
        source = self.directory / "batch-source"
        (source / "nested").mkdir(parents=True)
        (source / "alpha.bin").write_bytes(b"alpha")
        (source / "nested" / "beta file.txt").write_bytes(b"beta")
        with patch.object(upload_runner, "remote_inventory", side_effect=[({}, set()), ({"alpha.bin": 5, "nested/beta file.txt": 4}, {"nested"})]):
            receipt = upload_runner.execute(self.runtime, source, URI, parallel_files=2, dry_run=False)
        self.assertEqual(receipt["state"], "verified")
        self.assertEqual(receipt["total_bytes"], 9)
        self.assertEqual(len(receipt["results"]), 2)
        for relative, result in receipt["results"].items():
            run = self.runtime.get(result["run_id"])
            self.assertEqual(run["state"], "succeeded")
            self.assertFalse(run["inputs"]["overwrite"])
            self.assertEqual(run["inputs"]["local_path"], str(source / relative))
        stored = json.loads((self.runtime.root / "batches" / (receipt["batch_id"] + ".json")).read_text())
        self.assertFalse(stored["verification"]["full_remote_sha256"])

    def test_batch_stops_on_unknown_and_refuses_unproved_existing_file(self):
        source = self.directory / "batch-source"
        source.mkdir()
        for name in ["first.txt", "second.txt", "third.txt"]:
            (source / name).write_bytes(b"fixture")
        with patch.object(upload_runner, "remote_inventory", return_value=({"first.txt": 7}, set())):
            with self.assertRaises(FileExistsError):
                upload_runner.execute(self.runtime, source, URI, dry_run=False)
        unknown = {"run_id": "action_run_" + "0" * 32, "state": "outcome_unknown"}
        with patch.object(upload_runner, "remote_inventory", return_value=({}, set())), patch.object(self.runtime, "call", return_value=unknown) as invocation, patch.object(self.runtime, "wait", return_value=unknown):
            with self.assertRaisesRegex(RuntimeError, "no retry"):
                upload_runner.execute(self.runtime, source, URI, parallel_files=1, dry_run=False)
        self.assertEqual(invocation.call_count, 1)
        receipt = json.loads(next((self.runtime.root / "batches").glob("*.json")).read_text())
        self.assertEqual(receipt["state"], "needs_reconciliation")
        self.assertEqual(len(receipt["results"]), 1)

    def test_mcp_transport(self):
        async def exercise():
            mcp = FastMCP("action-test")
            register_action_tools(mcp, self.directory, self.runtime)
            async with Client(mcp) as client:
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertTrue({"action_retrieve", "action_call", "action_run_get", "action_run_cancel", "action_capabilities",
                                 "action_register", "action_get", "action_validate", "action_run_gc"} <= set(tools))
                self.assertTrue(tools["action_retrieve"].annotations.readOnlyHint)
                self.assertFalse(tools["action_call"].annotations.readOnlyHint)
                payload = (await client.call_tool("action_retrieve", {"task": "cosmos directory list"})).structured_content
                self.assertEqual(payload["selected_action_id"], "cosmos.directory.list")
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()