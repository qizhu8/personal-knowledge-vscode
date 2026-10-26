"""Agent authoring contracts and real isolated program/HTTP execution, without cloud access."""

import asyncio
import copy
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_authoring import authoring_contract, definition_schema
from action_modules import ModuleRuntime
from action_runtime import ActionRuntime, register_action_tools
from fastmcp import Client, FastMCP
from jsonschema import Draft202012Validator


class Authoring(unittest.TestCase):
    def test_review_first_validation_admits_only_after_smoke_passes(self):
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(self.example)
        report = {"approved": True, "summary": "Controlled echo; no external effects.", "issues": [], "model": "fixture-reviewer"}
        review = agent.qualification_review(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
        self.assertFalse((agent.registry / (proposal["action_id"] + ".json")).exists())
        result = agent.qualification_execute(proposal["action_id"], proposal["content_hash"], review["snapshot_hash"],
                                             report, proposal["proposal_id"])
        self.assertFalse((agent.registry / (proposal["action_id"] + ".json")).exists(),
                         "successful tests still wait for the host's final Root/trust recheck")
        result = agent.qualification_admit(result["attempt_id"])
        self.assertTrue(result["registered"])
        self.assertEqual(agent.availability(proposal["action_id"])["state"], "ready")
        self.assertEqual(agent.proposal_list()["proposals"], [])

    def test_failed_review_or_smoke_does_not_replace_previous_approved_version(self):
        original = self.runtime.register(self.example)
        self.grant(original)
        self.assertTrue(self.runtime.validate(original["action_id"], original["content_hash"])["ok"])
        updated = copy.deepcopy(self.example)
        updated["version"] = 2
        updated["examples"][0]["output"] = {"value": "wrong"}
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(updated)
        review = agent.qualification_review(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
        report = {"approved": False, "summary": "Invalid test.", "issues": ["Incorrect expected output"], "model": "fixture"}
        with patch.object(ModuleRuntime, "validate", side_effect=AssertionError("failed review must not execute")):
            with self.assertRaisesRegex(PermissionError, "Code review did not pass"):
                agent.qualification_execute(proposal["action_id"], proposal["content_hash"], review["snapshot_hash"],
                                             report, proposal["proposal_id"])
        report.update(approved=True, issues=[])
        with self.assertRaisesRegex(ValueError, "Smoke tests failed"):
            agent.qualification_execute(proposal["action_id"], proposal["content_hash"], review["snapshot_hash"],
                                         report, proposal["proposal_id"])
        self.assertEqual(agent.definition(original["action_id"])["content_hash"], original["content_hash"])
        self.assertEqual(agent.availability(original["action_id"])["state"], "ready")
        self.assertEqual(len(agent.proposal_list()["proposals"]), 1)

    def test_reviewed_build_qualification_transfers_and_changed_source_blocks_execution(self):
        builder = self.runtime.workspace() / "build_fixture.py"
        builder.write_text("import pathlib,sys\npathlib.Path(sys.argv[1]).write_text("
                           + repr("import json,sys\nprint(json.dumps(json.load(sys.stdin)))\n") + ")\n")
        definition = copy.deepcopy(self.example)
        definition["implementations"][0] = {
            "kind": "program", "platforms": ["Linux", "Darwin", "Windows"], "program": sys.executable,
            "args": ["${build_dir}/echo.py"],
            "build": {"program": sys.executable, "args": [str(builder), "${build_dir}/echo.py"],
                      "source_files": [str(builder)], "outputs": ["echo.py"]}}
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(definition)
        report = {"approved": True, "issues": [], "summary": "Fixture build reviewed", "model": "fixture"}
        review = agent.qualification_review(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
        builder.write_text(builder.read_text() + "\n")
        with patch.object(ModuleRuntime, "validate", side_effect=AssertionError("changed source cannot execute")):
            with self.assertRaisesRegex(ValueError, "changed after code review"):
                agent.qualification_execute(proposal["action_id"], proposal["content_hash"], review["snapshot_hash"],
                                             report, proposal["proposal_id"])
        review = agent.qualification_review(proposal["action_id"], proposal["content_hash"], proposal["proposal_id"])
        attempt = agent.qualification_execute(proposal["action_id"], proposal["content_hash"], review["snapshot_hash"],
                                               report, proposal["proposal_id"])
        agent.qualification_admit(attempt["attempt_id"])
        self.assertEqual(agent.availability(proposal["action_id"])["state"], "ready")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pkm-action-authoring-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = ModuleRuntime(self.root / "store")
        self.runtime.configure_workspace(str(self.root / "workspace"))
        self.example = authoring_contract()["examples"]["cli"]

    def snapshot(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def grant(self, definition):
        path = self.runtime.root / "policy.json"
        policy = json.loads(path.read_text()) if path.exists() else {"schema": "pkm.action.policy/v1", "grants": []}
        policy["grants"].append({"action_id": definition["action_id"],
                                "content_hash": definition["content_hash"], "trusted_host_execution": True})
        path.write_text(json.dumps(policy))

    def test_agent_proposal_is_not_registered_until_native_operator_admission(self):
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(self.example)
        self.assertEqual(proposal["state"], "pending_operator_approval")
        self.assertFalse(proposal["registered"])
        self.assertEqual(agent.register(self.example)["proposal_id"], proposal["proposal_id"])
        self.assertFalse((agent.registry / (self.example["action_id"] + ".json")).exists())
        self.assertFalse(any(item["action_id"] == self.example["action_id"] for item in agent.catalog()["actions"]))
        with self.assertRaises(FileNotFoundError):
            agent.validate(self.example["action_id"], proposal["content_hash"])
        review = agent.proposal_review(proposal["proposal_id"])
        with patch.object(agent, "validate", side_effect=AssertionError("approval must not execute")):
            agent.proposal_decide(proposal["proposal_id"], review["review_hash"], True)
        definition = agent.definition(self.example["action_id"])
        self.assertEqual(definition["content_hash"], proposal["content_hash"])
        self.assertTrue(agent.admitted(definition))
        agent.authorize(definition)
        self.assertNotEqual(agent.availability(definition["action_id"])["state"], "ready")
        with self.assertRaisesRegex(PermissionError, "ACTION_CODE_REVIEW_REQUIRED"):
            agent.validate(definition["action_id"], definition["content_hash"])
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])

    def test_proposed_update_keeps_old_approved_revision_and_rejection_does_not_mutate_it(self):
        definition = self.runtime.register(self.example)
        self.grant(definition)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        updated = copy.deepcopy(self.example)
        updated["version"] += 1
        proposal = agent.register(updated)
        self.assertEqual(agent.definition(definition["action_id"])["content_hash"], definition["content_hash"])
        agent.authorize(definition)
        run = agent.call(definition["action_id"], {"value": "previous version"}, "pending-update-original",
                         definition["content_hash"])
        self.assertEqual(agent.wait(run["run_id"])["output"], {"value": "previous version"})
        review = agent.proposal_review(proposal["proposal_id"], reject=True)
        agent.proposal_decide(proposal["proposal_id"], review["review_hash"], False)
        self.assertEqual(agent.definition(definition["action_id"])["content_hash"], definition["content_hash"])
        self.assertEqual(agent.proposal_list()["proposals"], [])
        with self.assertRaisesRegex(PermissionError, "not overwritten"):
            agent.source_save(definition["action_id"], "irrelevant", "changed", "irrelevant")
        proposal = agent.register(updated)
        review = agent.proposal_review(proposal["proposal_id"])
        newer = copy.deepcopy(updated)
        newer["version"] += 1
        self.runtime.register(newer)
        with self.assertRaisesRegex(ValueError, "approved Action changed"):
            agent.proposal_decide(proposal["proposal_id"], review["review_hash"], True)
        self.assertEqual(agent.definition(definition["action_id"])["version"], newer["version"])

    def test_proposal_approval_write_failure_rolls_back_and_unadmitted_pipeline_cannot_run(self):
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(self.example)
        review = agent.proposal_review(proposal["proposal_id"])
        from action_modules import _atomic_write
        registry = agent.registry / (self.example["action_id"] + ".json")

        def fail_registry(path, value):
            if path == registry:
                raise OSError("fixture registry write denied")
            return _atomic_write(path, value)

        with patch("action_modules._atomic_write", side_effect=fail_registry):
            with self.assertRaisesRegex(OSError, "registry write denied"):
                agent.proposal_decide(proposal["proposal_id"], review["review_hash"], True)
        self.assertFalse(registry.exists())
        self.assertFalse((agent.root / "policy.json").exists())
        self.assertEqual(len(agent.proposal_list()["proposals"]), 1)
        pipeline = {"schema": "pkm.action.definition/v1", "action_id": "example.unapproved.pipeline",
                    "version": 1, "description": "fixture", "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"}, "effects": ["pure"],
                    "implementations": [{"kind": "pipeline", "platforms": ["Linux", "Windows", "Darwin"], "steps": [], "output": {}}]}
        registered = self.runtime.register(pipeline)
        (agent.root / "admissions" / (pipeline["action_id"] + ".json")).unlink()
        with self.assertRaisesRegex(PermissionError, "ACTION_ADMISSION_REQUIRED"):
            agent.authorize(registered)
        self.assertNotIn(pipeline["action_id"], [item["action_id"] for item in agent.catalog()["actions"]])
        self.assertIn(pipeline["action_id"], [item["action_id"] for item in agent.catalog()["pending_admissions"]])

    def test_changed_source_blocks_approval_but_missing_source_does_not_block_rejection(self):
        source = self.runtime.workspace() / "proposed.py"
        source.write_text("first")
        definition = copy.deepcopy(self.example)
        definition["implementations"][0]["files"] = [str(source)]
        agent = ModuleRuntime(self.runtime.store, proposal_mode=True)
        proposal = agent.register(definition)
        review = agent.proposal_review(proposal["proposal_id"])
        source.write_text("changed during review")
        with self.assertRaisesRegex(ValueError, "changed during review"):
            agent.proposal_decide(proposal["proposal_id"], review["review_hash"], True)
        self.assertFalse((agent.registry / (definition["action_id"] + ".json")).exists())
        source.unlink()
        review = agent.proposal_review(proposal["proposal_id"], reject=True)
        self.assertEqual(agent.proposal_decide(proposal["proposal_id"], review["review_hash"], False)["state"], "rejected")

    def test_schema_and_nonmutating_preflight(self):
        Draft202012Validator.check_schema(definition_schema())
        before = self.snapshot()
        with patch.object(self.runtime, "call", side_effect=AssertionError("must not execute")):
            for value in authoring_contract()["examples"].values():
                Draft202012Validator(definition_schema()).validate(value)
                result = self.runtime.definition_check(value)
                self.assertTrue(result["ok"], result)
                self.assertFalse(result["persisted"])
                self.assertFalse(result["executed"])
                self.assertFalse(result["readiness_checked"])
        self.assertEqual(self.snapshot(), before)

    def test_invalid_kinds_fields_platforms_and_schemas_have_paths(self):
        mutations = [
            (lambda value: value["implementations"][0].update(kind="command"),
             "/implementations/0/kind", ["program", "pipeline", "mcp"]),
            (lambda value: value["implementations"][0].update(kind="python"),
             "/implementations/0/kind", ["program", "pipeline", "mcp"]),
            (lambda value: value["implementations"][0].pop("program"),
             "/implementations/0/program", None),
            (lambda value: value["implementations"][0].update(platforms=["linux"]),
             "/implementations/0/platforms/0", ["Linux", "Windows", "Darwin"]),
            (lambda value: value["implementations"][0].update(args="python -c ..."),
             "/implementations/0/args", None),
            (lambda value: value["input_schema"].update(type="bogus"),
             "/input_schema/type", None),
        ]
        before = self.snapshot()
        for mutate, path, allowed in mutations:
            with self.subTest(path=path, allowed=allowed):
                value = copy.deepcopy(self.example)
                mutate(value)
                result = self.runtime.definition_check(value)
                self.assertFalse(result["ok"])
                matches = [item for item in result["diagnostics"] if item["path"].startswith(path)]
                self.assertTrue(matches, result)
                if allowed:
                    self.assertEqual(matches[0]["allowed_values"], allowed)
                with self.assertRaises(ValueError):
                    self.runtime.register(value)
        self.assertEqual(self.snapshot(), before)

    def test_semantic_errors_and_existing_version_are_not_persisted(self):
        self.runtime.register(self.example)
        before = self.snapshot()
        result = self.runtime.definition_check(self.example)
        self.assertEqual(result["diagnostics"][0]["path"], "/version")
        invalid = copy.deepcopy(self.example)
        invalid["action_id"] = "core.delay"
        self.assertFalse(self.runtime.definition_check(invalid)["ok"])
        invalid["action_id"] = "example.missing-dependency"
        invalid["dependencies"] = {"fixture.not.registered": "0" * 64}
        self.assertFalse(self.runtime.definition_check(invalid)["ok"])
        invalid["dependencies"] = {}
        invalid["implementations"] = [{"kind": "pipeline", "platforms": ["Linux"],
                                       "steps": [{"id": "invalid", "component": "missing", "inputs": {}}]}]
        self.assertFalse(self.runtime.definition_check(invalid)["ok"])
        self.assertEqual(self.snapshot(), before)

    def test_cli_register_grant_qualify_call_and_idempotent_receipt(self):
        definition = self.runtime.register(self.example)
        self.assertEqual(self.runtime.availability(definition["action_id"])["state"], "blocked")
        with self.assertRaises(PermissionError):
            self.runtime.validate(definition["action_id"], definition["content_hash"])
        self.grant(definition)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.runtime.availability(definition["action_id"])["state"], "ready")
        arguments = (definition["action_id"], {"value": "from stdin, not argv"}, "same-key", definition["content_hash"])
        run = self.runtime.call(*arguments)
        completed = self.runtime.wait(run["run_id"])
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["output"], {"value": "from stdin, not argv"})
        self.assertEqual(self.runtime.call(*arguments)["run_id"], run["run_id"])

    def test_missing_host_grant_gives_operator_handoff_without_mutation(self):
        definition = self.runtime.register(self.example)
        before = self.snapshot()
        with self.assertRaises(PermissionError) as raised:
            self.runtime.authorize(definition)
        message = str(raised.exception)
        for required in [
            "ACTION_HOST_TRUST_REQUIRED", definition["action_id"], definition["content_hash"],
            str(self.runtime.root / "policy.json"), "not a definition/schema error",
            "Agent: stop", "do not edit the policy", "do not re-register",
            "not a sandbox", "trusted_host_execution", "action_validation_enqueue",
        ]:
            self.assertIn(required, message)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.runtime.availability(definition["action_id"])["reason"], message)
        self.grant(definition)
        self.runtime.authorize(definition)

    def test_operator_review_grants_exact_revision_preserves_policy_and_revokes(self):
        definition = self.runtime.register(self.example)
        path = self.runtime.root / "policy.json"
        existing = {"schema": "pkm.action.policy/v1", "operator_note": "preserve",
                    "grants": [{"action_id": "other.action", "content_hash": "other", "remote_root": "/keep"}]}
        path.write_text(json.dumps(existing))
        before = self.snapshot()
        review = self.runtime.host_trust_review(definition["action_id"], definition["content_hash"])
        self.assertFalse(review["granted"])
        self.assertEqual(self.snapshot(), before, "review must never grant or execute")
        args = (definition["action_id"], definition["content_hash"], review["review_hash"])
        with self.assertRaisesRegex(ValueError, "review again"):
            self.runtime.host_trust_update(*args[:2], "stale", True)
        self.assertEqual(self.snapshot(), before)
        with patch.object(self.runtime, "validate", side_effect=AssertionError("must not execute")):
            self.runtime.host_trust_update(*args, True)
        self.runtime.authorize(definition)
        policy = json.loads(path.read_text())
        self.assertEqual(policy["operator_note"], "preserve")
        self.assertEqual(policy["grants"][0], existing["grants"][0])
        with self.assertRaisesRegex(ValueError, "review again"):
            self.runtime.host_trust_update(*args, True)
        review = self.runtime.host_trust_review(*args[:2])
        self.runtime.host_trust_update(*args[:2], review["review_hash"], False)
        with self.assertRaises(PermissionError):
            self.runtime.authorize(definition)
        with self.assertRaisesRegex(ValueError, "Action changed"):
            self.runtime.host_trust_review(definition["action_id"], "wrong")

    def test_operator_review_rejects_changed_source_invalid_policy_and_write_failure(self):
        value = copy.deepcopy(self.example)
        source = self.root / "source.py"
        source.write_text("print('reviewed')")
        value["implementations"][0]["files"] = [str(source)]
        definition = self.runtime.register(value)
        args = (definition["action_id"], definition["content_hash"])
        review = self.runtime.host_trust_review(*args)
        source.write_text("print('changed')")
        with self.assertRaisesRegex(ValueError, "review again"):
            self.runtime.host_trust_update(*args, review["review_hash"], True)
        review = self.runtime.host_trust_review(*args)
        with patch("action_modules._atomic_write", side_effect=OSError("fixture write denied")):
            with self.assertRaisesRegex(OSError, "fixture write denied"):
                self.runtime.host_trust_update(*args, review["review_hash"], True)
        with self.assertRaises(PermissionError):
            self.runtime.authorize(definition)
        policy = self.runtime.root / "policy.json"
        policy.write_text('{"schema":"unexpected","grants":[]}')
        with self.assertRaisesRegex(ValueError, "Invalid operator policy"):
            self.runtime.host_trust_review(*args)
        self.assertEqual(policy.read_text(), '{"schema":"unexpected","grants":[]}')

    def test_http_fixture_qualification_failure_and_bounded_output(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                body = (b'{"status":"completed","result":"failed","terminal":true}'
                        if self.path == "/status" else b"not json")
                if self.path == "/large":
                    body = b"x" * 65537
                self.send_response(403 if self.path == "/forbidden" else 200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        url = "http://127.0.0.1:" + str(server.server_port)
        value = authoring_contract()["examples"]["http_get_json"]
        value["examples"] = [{"inputs": {"url": url + "/status"}}]
        definition = self.runtime.register(value)
        self.grant(definition)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        for path in ["/status", "/forbidden", "/bad-json", "/large"]:
            with self.subTest(path=path):
                run = self.runtime.call(definition["action_id"], {"url": url + path}, path, definition["content_hash"])
                completed = self.runtime.wait(run["run_id"])
                if path == "/status":
                    self.assertEqual(completed["state"], "succeeded", completed)
                    self.assertEqual(completed["output"]["response"],
                                     {"status": "completed", "result": "failed", "terminal": True})
                else:
                    self.assertNotEqual(completed["state"], "succeeded", completed)
                    self.assertIsNone(completed.get("output"))
        self.assertEqual(requests, ["/status", "/status", "/forbidden", "/bad-json", "/large"])

    def test_real_mcp_discovery_and_preflight_readonly_annotation(self):
        async def exercise():
            runtime = ActionRuntime(self.runtime.store)
            server = FastMCP("action-authoring-fixture")
            register_action_tools(server, self.runtime.store, runtime)
            async with Client(server) as client:
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertFalse(any("host_trust" in name or "review_host_trust" in name for name in tools),
                                 "host-trust approval must not be exposed as an MCP self-grant tool")
                self.assertNotIn("proposal_decide", tools)
                self.assertTrue(tools["action_proposals"].annotations.readOnlyHint)
                self.assertTrue(tools["action_definition_check"].annotations.readOnlyHint)
                self.assertFalse(tools["action_register"].annotations.readOnlyHint)
                capabilities = (await client.call_tool("action_capabilities", {})).structured_content
                self.assertIn("action_definition_check", capabilities["tools"])
                self.assertIn("caller shell", capabilities["execution_host"]["filesystem"])
                definition = capabilities["authoring"]["examples"]["cli"]
                result = (await client.call_tool("action_definition_check", {"definition": definition})).structured_content
                self.assertTrue(result["ok"], result)
                self.assertFalse((runtime.modules.registry / (definition["action_id"] + ".json")).exists())
                submitted = (await client.call_tool("action_register", {"definition": definition})).structured_content
                self.assertEqual(submitted["state"], "pending_operator_approval")
                self.assertFalse(submitted["registered"])
                self.assertFalse((runtime.modules.registry / (definition["action_id"] + ".json")).exists())
                proposals = (await client.call_tool("action_proposals", {})).structured_content
                self.assertEqual(proposals["proposals"][0]["proposal_id"], submitted["proposal_id"])
                definition["implementations"][0]["kind"] = "python"
                result = (await client.call_tool("action_definition_check", {"definition": definition})).structured_content
                self.assertEqual(result["diagnostics"][0]["path"], "/implementations/0/kind")
                scheduler = runtime._scheduler
                if scheduler:
                    scheduler.join(timeout=5)
                    self.assertFalse(scheduler.is_alive())
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
