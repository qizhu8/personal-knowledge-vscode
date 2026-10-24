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
        policy = json.loads(path.read_text()) if path.exists() else {"grants": []}
        policy["grants"].append({"action_id": definition["action_id"],
                                "content_hash": definition["content_hash"], "trusted_host_execution": True})
        path.write_text(json.dumps(policy))

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
                self.assertTrue(tools["action_definition_check"].annotations.readOnlyHint)
                self.assertFalse(tools["action_register"].annotations.readOnlyHint)
                capabilities = (await client.call_tool("action_capabilities", {})).structured_content
                self.assertIn("action_definition_check", capabilities["tools"])
                self.assertIn("caller shell", capabilities["execution_host"]["filesystem"])
                definition = capabilities["authoring"]["examples"]["cli"]
                result = (await client.call_tool("action_definition_check", {"definition": definition})).structured_content
                self.assertTrue(result["ok"], result)
                self.assertFalse((runtime.modules.registry / (definition["action_id"] + ".json")).exists())
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
