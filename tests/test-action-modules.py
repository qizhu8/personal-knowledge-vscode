import json
import asyncio
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_modules import ModuleRuntime, digest, INTEGER, object_schema
from action_components import pending_choices, answer_choice, execute_steps, cast_value, math_expression, component_definitions


class MathExpressionTests(unittest.TestCase):
    def test_expression_functions_and_bounds(self):
        import math
        self.assertEqual(math_expression("{0} x {1} + {2} * log {3}",
                                        {"input_0": 2, "input_1": 3, "input_2": 4, "input_3": math.e}), 10)
        self.assertEqual(math_expression("max({0}, {1}) + sqrt(16) + 2^3", {"input_0": 1, "input_1": 5}), 17)
        self.assertAlmostEqual(math_expression("sin(pi / 2) + log(8, 2)", {}), 4)
        for expression, inputs in [("{32}", {}), ("{0}", {}), ("{0}", {"input_0": True}),
                                   ("log(-1)", {}), ("1/0", {}), ("2**100000000", {}),
                                   ("__import__('os')", {}), ("math.log(2)", {}), ("[1][0]", {}),
                                   ("1e101", {}), ("sqrt(value=4)", {})]:
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                math_expression(expression, inputs)
        definitions = component_definitions()
        self.assertEqual(definitions["core.switch"]["category"], "core/logic")
        self.assertEqual(definitions["core.user-action"]["category"], "core/logic")
        self.assertEqual(definitions["core.math-expression"]["math_functions"]["log"], "math.log")

    def test_numbered_math_ports_in_executable_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = ModuleRuntime(Path(directory) / "store")
            runtime.configure_workspace(directory)
            components = {item["action_id"]: item for item in runtime.components()}
            example = components["core.math-expression"]["examples"][0]
            graph = {"action_id": "test.math.expression", "nodes": [
                {"id": "number", "action_id": "core.constant", "value_type": "number",
                 "content_hash": components["core.constant"]["content_hash"], "parameters": {"value": 5}},
                {"id": "math", "action_id": "core.math-expression",
                 "content_hash": components["core.math-expression"]["content_hash"], "parameters": example["inputs"]}],
                "edges": [{"source": "number", "output": "value", "target": "math", "input": "input_0"}], "output_node": "math"}
            definition = runtime.graph_save(graph)
            self.assertTrue(runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
            run = runtime.call(definition["action_id"], {}, "math-wired", definition["content_hash"])
            self.assertEqual(runtime.wait(run["run_id"])["output"], {"value": 19})
            catalog = runtime.catalog()["actions"]
            self.assertFalse(any(item["action_id"] == "core.integer.add" for item in catalog))
            with self.assertRaises(FileNotFoundError):
                runtime.definition("core.integer.add")


    def test_retired_math_dependency_does_not_break_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = ModuleRuntime(Path(temporary) / "store")
            runtime.configure_workspace(str(Path(temporary) / "workspace"))
            register_test_add(runtime)
            path = runtime.registry / "test.fixture.add.json"
            legacy = json.loads(path.read_text())
            legacy["dependencies"] = {"core.integer.add": "0" * 64}
            legacy["implementations"][0]["steps"] = [{"id": "sum", "action_id": "core.integer.add",
                "inputs": {"left": {"$input": "left"}, "right": {"$input": "right"}}}]
            legacy["implementations"][0]["output"] = {"sum": {"$step": "sum.sum"}}
            path.write_text(json.dumps(legacy))
            catalog = runtime.catalog()["actions"]
            retired = next(item for item in catalog if item["action_id"] == "test.fixture.add")
            self.assertEqual(retired["availability"]["state"], "blocked")
            self.assertIn("core.integer.add", retired["availability"]["reason"])
            self.assertTrue(any(item["action_id"] == "core.math-expression" for item in catalog))
            self.assertFalse(any(item["action_id"] == "core.integer.add" for item in catalog))


def register_test_add(runtime):
    return runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.fixture.add", "version": 1,
        "input_schema": object_schema({"left": INTEGER, "right": INTEGER}), "output_schema": object_schema({"sum": INTEGER}),
        "effects": ["pure"], "examples": [{"inputs": {"left": 2, "right": 3}, "output": {"sum": 5}}],
        "implementations": [{"kind": "pipeline", "platforms": ["Linux", "Windows", "Darwin"], "steps": [{
            "id": "sum", "component": "core.math-expression", "inputs": {"expression": "{0} + {1}",
                "input_0": {"$input": "left"}, "input_1": {"$input": "right"}}}], "output": {"sum": {"$step": "sum.value"}}}]})


class ModuleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.runtime = ModuleRuntime(self.directory / "store")
        self.runtime.configure_workspace(str(self.directory / "workspace"))
        register_test_add(self.runtime)
        for action in ["test.fixture.add", "core.date.parse"]:
            self.assertTrue(self.runtime.validate(action, self.runtime.definition(action)["content_hash"])["ok"])

    def call(self, name, inputs, key="test"):
        return self.runtime.wait(self.runtime.call(name, inputs, key, self.runtime.definition(name)["content_hash"])["run_id"])

    def test_optional_host_toolchain_bindings(self):
        self.assertEqual(self.runtime.resolve_program("python"), sys.executable)
        settings_path = self.runtime.root / "settings.json"
        settings = self.runtime.settings()
        host = {"Linux": "linux", "Windows": "windows", "Darwin": "macos"}[platform.system()]
        settings["toolchains"] = {host: {"dotnet": sys.executable, "rustc": sys.executable}}
        settings_path.write_text(json.dumps(settings))
        self.assertEqual(self.runtime.resolve_program("dotnet"), str(Path(sys.executable).resolve()))
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.toolchain.binding", "version": 1,
            "input_schema": {"type": "object", "properties": {}}, "output_schema": {"type": "object", "properties": {}}, "effects": ["pure"],
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": "dotnet", "args": ["--version"]}], "examples": [{"inputs": {}}]})
        before = self.runtime.fingerprint(definition)
        alternative = self.directory / "python-alternative"
        shutil.copyfile(sys.executable, alternative)
        alternative.chmod(0o700)
        settings["toolchains"][host]["dotnet"] = str(alternative)
        settings_path.write_text(json.dumps(settings))
        self.assertNotEqual(self.runtime.fingerprint(definition), before, "A changed host executable path must invalidate qualification")
        for invalid in ["relative/python", str(self.directory / "missing")]:
            settings["toolchains"][host]["dotnet"] = invalid
            settings_path.write_text(json.dumps(settings))
            with self.assertRaises(PermissionError):
                self.runtime.resolve_program("dotnet")
        with patch("action_modules.shutil.which", return_value=None):
            with self.assertRaisesRegex(PermissionError, "PKM does not install SDKs"):
                self.runtime.resolve_program("unconfigured-sdk")

    def test_unified_cast_component(self):
        for value, target, expected in [("42", "integer", 42), ("1.5e2", "number", 150.0),
                ("false", "boolean", False), (True, "string", "true"), ('{"a":1}', "object", {"a": 1}),
                ("[1,2]", "array", [1, 2]), ("null", "null", None), (3.0, "integer", 3)]:
            self.assertEqual(cast_value(value, target), expected)
        for value, target in [(3.1, "integer"), (True, "integer"), ("01", "integer"),
                (" 42 ", "integer"), ("1e999", "number"), ("1e-999", "number"),
                ("[]", "object"), ("NaN", "array"), ("False", "boolean"), (0, "null")]:
            with self.assertRaises(ValueError):
                cast_value(value, target)
        self.assertEqual(cast_value(" 42 ", "integer", True), 42)
        constant = self.runtime.component("core.constant", "string")
        cast = self.runtime.component("core.cast", "integer")
        add = self.runtime.definition("test.fixture.add")
        graph = {"action_id": "test.cast.graph", "nodes": [
            {"id": "text", "action_id": "core.constant", "value_type": "string", "content_hash": constant["content_hash"], "parameters": {"value": "42"}},
            {"id": "cast", "action_id": "core.cast", "value_type": "integer", "content_hash": cast["content_hash"], "parameters": {"value": "", "target_type": "integer"}},
            {"id": "add", "action_id": "test.fixture.add", "content_hash": add["content_hash"], "parameters": {"right": 1}}],
            "edges": [{"source": "text", "output": "value", "target": "cast", "input": "value"}, {"source": "cast", "output": "value", "target": "add", "input": "left"}], "output_node": "add"}
        definition = self.runtime.graph_save(graph)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {})["output"], {"sum": 43})
        catalog = self.runtime.catalog()["actions"]
        self.assertEqual([item["action_id"] for item in catalog if item["action_id"].startswith("core.cast") and not item.get("palette_hidden")], ["core.cast"])
        legacy = self.runtime.definition("core.cast.string-to-integer")
        self.assertTrue(self.runtime.validate(legacy["action_id"], legacy["content_hash"])["ok"])
        self.assertEqual(self.call(legacy["action_id"], {"value": "42"}, "legacy-cast")["output"], {"value": 42})

    def test_catalog_authoring_persists_without_changing_pins(self):
        component = self.runtime.component("core.constant", "integer")
        action = self.runtime.graph_save({"action_id": "test.catalog.action", "name": "Original", "nodes": [{
            "id": "constant", "action_id": "core.constant", "content_hash": component["content_hash"],
            "value_type": "integer", "parameters": {"value": 7}}], "edges": [], "output_node": "constant"})
        self.runtime.group_create("Tools")
        self.runtime.group_create("Numbers", "Tools")
        self.runtime.action_rename(action["action_id"], "Renamed")
        self.runtime.action_move(action["action_id"], "Tools/Numbers")
        fresh = ModuleRuntime(self.runtime.store)
        self.assertEqual(fresh.catalog_layout()["actions"][action["action_id"]], {"display_name": "Renamed", "category": "Tools/Numbers"})
        self.assertEqual(fresh.definition(action["action_id"])["content_hash"], action["content_hash"])
        for operation in [lambda: fresh.group_create("User", "core"), lambda: fresh.group_create("CORE"),
                          lambda: fresh.action_rename("core.constant", "Changed"),
                          lambda: fresh.action_move("core.date.parse", "Tools"),
                          lambda: fresh.action_move(action["action_id"], "core")]:
            with self.assertRaises(PermissionError):
                operation()
        with self.assertRaises(ValueError):
            fresh.group_create("../escape")
        with self.assertRaises(ValueError):
            fresh.action_move(action["action_id"], "Missing")
        catalog = fresh.catalog()
        entry = next(item for item in catalog["actions"] if item["action_id"] == action["action_id"])
        self.assertEqual((entry["display_name"], entry["category"], entry["language"], entry["editable"]),
                         ("Renamed", "Tools/Numbers", "Python", True))
        self.assertTrue(all(item["read_only"] and not item["editable"] for item in catalog["actions"] if item["category"] == "core"))
        with self.assertRaises(PermissionError):
            fresh.definition_read("core.constant")
        with self.assertRaises(PermissionError):
            fresh.action_delete("core.date.parse", "ignored")
        document = fresh.definition_read(action["action_id"])
        document["definition"]["version"] = 2
        fresh.definition_save(action["action_id"], document["definition"], document["content_hash"])
        with self.assertRaises(ValueError):
            fresh.action_delete(action["action_id"], action["content_hash"])
        fresh.action_delete(action["action_id"], fresh.definition(action["action_id"])["content_hash"])
        self.assertNotIn(action["action_id"], fresh.catalog_layout()["actions"])
        self.assertFalse((fresh.registry / (action["action_id"] + ".json")).exists())

    def test_authoring_languages_sources_and_dependency_delete_guard(self):
        schema = {"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"]}
        definitions = []
        for identifier, filename, program in [("test.language.python", "main.py", "python"), ("test.language.csharp", "Main.cs", "dotnet")]:
            source = self.directory / filename
            source.write_text("print('original')" if filename.endswith(".py") else "class Program {}")
            definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": identifier, "version": 1,
                "input_schema": schema, "output_schema": schema, "effects": ["pure"],
                "implementations": [{"kind": "program", "platforms": [platform.system()], "program": program,
                                      "args": [str(source)], "files": [str(source)]}], "examples": [{"inputs": {"value": 1}}]})
            definitions.append(definition)
        self.assertEqual(self.runtime.action_languages(definitions[0]), {"Python"})
        self.assertEqual(self.runtime.action_languages(definitions[1]), {"C#"})
        parent = {"action_id": "test.language.hybrid", "dependencies": {item["action_id"]: item["content_hash"] for item in definitions},
                  "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": []}]}
        self.assertEqual(self.runtime.action_languages(parent), {"Python", "C#"})
        document = self.runtime.source_read(definitions[0]["action_id"], str(self.directory / "main.py"))
        update = self.runtime.definition_read(definitions[0]["action_id"])
        update["definition"]["version"] = 2
        job = self.runtime.queue_enqueue(definitions[0]["action_id"], definitions[0]["content_hash"], launch=False)
        for operation in [lambda: self.runtime.source_save(definitions[0]["action_id"], document["filename"], "queued", document["source_hash"]),
                          lambda: self.runtime.definition_save(definitions[0]["action_id"], update["definition"], update["content_hash"]),
                          lambda: self.runtime.action_delete(definitions[0]["action_id"], definitions[0]["content_hash"])]:
            with self.assertRaisesRegex(PermissionError, "validation"):
                operation()
        self.runtime.queue_cancel(job["job_id"])
        record = self.runtime.root / "runs" / "authoring-guard" / "run.json"
        record.parent.mkdir(parents=True)
        record.write_text(json.dumps({"state": "running", "action_id": "test.running.parent",
                                      "definition": {"dependencies": {definitions[0]["action_id"]: definitions[0]["content_hash"]}}}))
        with self.assertRaisesRegex(PermissionError, "running call"):
            self.runtime.definition_save(definitions[0]["action_id"], update["definition"], update["content_hash"])
        record.unlink()
        with self.assertRaisesRegex(ValueError, "changed"):
            self.runtime.register(update["definition"], expected_content_hash="stale")
        literal = {**parent, "dependencies": {definitions[1]["action_id"]: definitions[1]["content_hash"]},
                   "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": [{
                       "action_id": definitions[1]["action_id"], "inputs": {"literal": {"component": "core.constant"}}}]}]}
        self.assertEqual(self.runtime.action_languages(literal), {"C#"})
        self.runtime.source_save(definitions[0]["action_id"], document["filename"], "print('edited')", document["source_hash"])
        self.assertEqual((self.directory / "main.py").read_text(), "print('edited')")
        with self.assertRaises(ValueError):
            self.runtime.source_save(definitions[0]["action_id"], document["filename"], "stale", document["source_hash"])
        with self.assertRaises(PermissionError):
            self.runtime.source_read(definitions[0]["action_id"], str(self.directory / "unrelated.py"))
        self.runtime.registry.joinpath("test.language.parent.json").write_text(json.dumps({**definitions[1], **parent}))
        with self.assertRaisesRegex(PermissionError, "referenced"):
            self.runtime.action_delete(definitions[0]["action_id"], definitions[0]["content_hash"])

    def test_builtin_and_validation(self):
        result = self.call("test.fixture.add", {"left": 3, "right": 4})
        self.assertEqual(result["output"], {"sum": 7})
        self.assertEqual(self.call("test.fixture.add", {"left": 3, "right": 4})["run_id"], result["run_id"])
        with self.assertRaises(ValueError):
            self.call("test.fixture.add", {"left": "3", "right": 4}, "no-implicit-cast")
        self.assertEqual(self.call("test.fixture.add", {"left": 2**63-1, "right": 1}, "overflow")["state"], "failed")
        with self.assertRaises(ValueError):
            self.call("core.date.parse", {"value": "2026-02-30"}, "bad-date")

    def test_nested_pipeline(self):
        child = self.runtime.definition("test.fixture.add")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.nested.add", "version": 1,
            "description": "Two nested additions", "effects": ["pure"], "input_schema": child["input_schema"],
            "output_schema": child["output_schema"], "dependencies": {child["action_id"]: child["content_hash"]},
            "implementations": [{"kind": "pipeline", "platforms": ["Linux", "Windows", "Darwin"],
                "steps": [{"id": "first", "action_id": child["action_id"], "inputs": {"left": {"$input": "left"}, "right": 1}},
                          {"id": "second", "action_id": child["action_id"], "inputs": {"left": {"$step": "first.sum"}, "right": {"$input": "right"}}}],
                "output": {"sum": {"$step": "second.sum"}}}],
            "examples": [{"inputs": {"left": 2, "right": 3}, "output": {"sum": 6}}]})
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        result = self.call(definition["action_id"], {"left": 10, "right": 20})
        self.assertEqual(result["output"], {"sum": 31})
        children = [json.loads(path.read_text()) for path in (self.runtime.root / "runs").glob("*/run.json")]
        self.assertEqual(sum(record.get("parent_run_id") == result["run_id"] for record in children), 2)

    def test_only_completed_actions_can_be_nested(self):
        child = self.runtime.definition("core.cast.string-to-integer")
        graph = {"action_id": "test.completed.parent", "nodes": [{"id": "child", "action_id": child["action_id"],
                 "content_hash": child["content_hash"], "parameters": {"value": "42"}}], "edges": [], "output_node": "child"}
        with self.assertRaisesRegex(ValueError, "completed validation"):
            self.runtime.graph_save(graph)
        self.assertFalse((self.runtime.registry / "test.completed.parent.json").exists())
        self.assertTrue(self.runtime.validate(child["action_id"], child["content_hash"])["ok"])
        parent = self.runtime.graph_save(graph)
        with self.assertRaisesRegex(ValueError, "completed validation"):
            self.runtime.completed_dependencies("test.outer.parent", {parent["action_id"]: parent["content_hash"]})
        self.assertTrue(self.runtime.validate(parent["action_id"], parent["content_hash"])["ok"])
        self.runtime.completed_dependencies("test.outer.parent", {parent["action_id"]: parent["content_hash"]})
        with self.assertRaisesRegex(ValueError, "Nested Action cycle"):
            self.runtime.completed_dependencies(parent["action_id"], {parent["action_id"]: parent["content_hash"]})
        graph["version"] = 2
        graph["nodes"] = [{"id": "self", "action_id": parent["action_id"], "content_hash": parent["content_hash"], "parameters": {}}]
        graph["output_node"] = "self"
        with self.assertRaisesRegex(ValueError, "Nested Action cycle"):
            self.runtime.graph_save(graph)
        raw = json.loads((self.runtime.registry / (parent["action_id"] + ".json")).read_text())
        raw["dependencies"] = {parent["action_id"]: parent["content_hash"]}
        (self.runtime.registry / (parent["action_id"] + ".json")).write_text(json.dumps(raw))
        self.assertEqual(self.runtime.availability(parent["action_id"])["state"], "blocked")
        self.assertIn("Nested Action cycle", self.runtime.availability(parent["action_id"])["reason"])

    def component_action(self, name, steps, output, effects=None):
        return self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": name, "version": 1,
            "description": "Basic component fixture", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
            "output_schema": {"type": "object", "properties": {"value": {}}, "required": ["value"], "additionalProperties": False},
            "effects": effects or ["pure"], "dependencies": {"test.fixture.add": self.runtime.definition("test.fixture.add")["content_hash"]},
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": steps, "output": {"value": output}}],
            "examples": [{"inputs": {}}]})

    def test_sleep_component_waits_and_obeys_cancellation(self):
        component = self.runtime.component("core.sleep")
        self.assertEqual(component["input_schema"]["properties"]["seconds"]["default"], 1)
        implementation = {"steps": [{"id": "pause", "component": "core.sleep", "inputs": {"seconds": 0.03}}],
                          "output": {"seconds": {"$step": "pause.seconds"}}}
        record = {"run_id": "action_run_" + "a" * 32, "inputs": {}, "deadline": time.time() + 5}
        started = time.monotonic()
        self.assertEqual(execute_steps(self.runtime, record, None, implementation), {"seconds": 0.03})
        self.assertGreaterEqual(time.monotonic() - started, 0.03)
        implementation["steps"][0]["inputs"]["seconds"] = 0
        self.assertEqual(execute_steps(self.runtime, record, None, implementation), {"seconds": 0})
        implementation["steps"][0]["inputs"]["seconds"] = 10
        with patch.object(self.runtime, "cancelled", side_effect=[False, False, True]), \
                patch("action_components.time.monotonic", return_value=0), patch("action_components.time.sleep") as sleeper:
            with self.assertRaisesRegex(TimeoutError, "Sleep cancelled"):
                execute_steps(self.runtime, record, None, implementation)
            sleeper.assert_called_once_with(0.05)
        record["deadline"] = time.time() - 1
        with patch("action_components.time.sleep") as sleeper:
            with self.assertRaises(TimeoutError):
                execute_steps(self.runtime, record, None, implementation)
            sleeper.assert_not_called()
        for seconds in [-1, 301, True, "1", float("nan"), float("inf")]:
            graph = {"action_id": "test.sleep.invalid", "nodes": [{"id": "pause", "action_id": "core.sleep",
                     "content_hash": component["content_hash"], "parameters": {"seconds": seconds}}],
                     "edges": [], "output_node": "pause"}
            with self.assertRaises(ValueError):
                self.runtime.graph_save(graph)
        graph["action_id"] = "test.sleep.valid"
        graph["nodes"][0]["parameters"] = {"seconds": 0.01}
        definition = self.runtime.graph_save(graph)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {})["output"], {"seconds": 0.01})
        entry = next(item for item in self.runtime.catalog()["actions"] if item["action_id"] == "core.sleep")
        self.assertTrue(entry["read_only"])
        self.assertFalse(entry["editable"])

    def test_basic_components_control_flow_constants_and_lookup(self):
        child = {"id": "add", "action_id": "test.fixture.add", "inputs": {"left": {"$var": "item"}, "right": 1}}
        definition = self.component_action("test.core.components", [
            {"id": "dictionary", "component": "core.constant", "inputs": {"value": {"name": "chosen"}}},
            {"id": "lookup", "component": "core.lookup", "inputs": {"dictionary": {"$step": "dictionary.value"}, "key": "name"}},
            {"id": "branch", "component": "core.if-else", "inputs": {"condition": True, "then_value": {"$step": "lookup.value"}, "else_value": "wrong",
                "else_steps": [{"id": "never", "action_id": "test.fixture.add", "inputs": {"left": "invalid", "right": 1}}]}},
            {"id": "switch", "component": "core.switch", "inputs": {"selector": {"$step": "branch.value"}, "cases": [{"match": "chosen", "value": "matched"}], "default_value": "wrong"}},
            {"id": "loop", "component": "core.for", "inputs": {"items": [1, 2, 3], "body": [child], "value": {"$step": "add.sum"}, "max_iterations": 3}},
            {"id": "counter", "component": "core.constant", "inputs": {"value": 0}},
            {"id": "while", "component": "core.while", "inputs": {"condition": {"$op": "lt", "args": [{"$step": "counter.value"}, 3]},
                "body": [{"id": "counter", "component": "core.constant", "inputs": {"value": {"$op": "add", "args": [{"$step": "counter.value"}, 1]}}}],
                "value": {"$step": "counter.value"}, "max_iterations": 3}}],
            {"for": {"$step": "loop.values"}, "while": {"$step": "while.value"}, "switch": {"$step": "switch.value"}})
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        result = self.call(definition["action_id"], {}, "basic-flow")
        self.assertEqual(result["output"], {"value": {"for": [2, 3, 4], "while": 3, "switch": "matched"}})
        children = [json.loads(path.read_text()) for path in (self.runtime.root / "runs").glob("*/run.json")]
        self.assertEqual(sum(record.get("parent_run_id") == result["run_id"] for record in children), 3)
        missing = self.component_action("test.core.missing", [{"id": "lookup", "component": "core.lookup", "inputs": {"dictionary": {}, "key": "missing"}}], {"$step": "lookup.value"})
        self.assertFalse(self.runtime.validate(missing["action_id"], missing["content_hash"])["ok"])
        fallback = self.component_action("test.core.fallback", [{"id": "lookup", "component": "core.lookup", "inputs": {"dictionary": {}, "key": "missing", "default": {"$literal": {"$op": "ordinary dictionary data"}}}}], {"$step": "lookup.value"})
        self.assertTrue(self.runtime.validate(fallback["action_id"], fallback["content_hash"])["ok"])
        self.assertEqual(self.call(fallback["action_id"], {}, "fallback")["output"], {"value": {"$op": "ordinary dictionary data"}})
        bounded = self.component_action("test.core.bounded", [{"id": "loop", "component": "core.while", "inputs": {"condition": True, "body": [], "value": 0, "max_iterations": 2}}], {"$step": "loop.value"})
        self.assertFalse(self.runtime.validate(bounded["action_id"], bounded["content_hash"])["ok"])
        with self.assertRaisesRegex(ValueError, "max_iterations"):
            self.component_action("test.core.unbounded", [{"id": "loop", "component": "core.while", "inputs": {"condition": True, "body": [], "value": 0, "max_iterations": 0}}], 0)

    def test_basic_component_graph_paths_and_chat_choice(self):
        components = {item["action_id"]: item for item in self.runtime.components()}
        graph = {"action_id": "test.core.graph", "nodes": [{"id": "constant", "action_id": "core.constant", "value_type": "integer",
                 "content_hash": components["core.constant"]["content_hash"], "parameters": {"value": 42}}], "edges": [], "output_node": "constant"}
        definition = self.runtime.graph_save(graph)
        self.assertEqual(definition["dependencies"], {})
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {}, "constant-graph")["output"], {"value": 42})
        path = self.component_action("test.core.path", [{"id": "path", "component": "core.file-path", "inputs": {"path": "new.txt"}}], {"$step": "path.path"}, ["pure", "local-read"])
        self.assertTrue(self.runtime.validate(path["action_id"], path["content_hash"])["ok"])
        self.assertEqual(self.call(path["action_id"], {}, "path")["output"], {"value": str(self.runtime.workspace() / "new.txt")})
        outside = self.component_action("test.core.outside", [{"id": "path", "component": "core.file-path", "inputs": {"path": "../outside.txt"}}], {"$step": "path.path"}, ["pure", "local-read"])
        self.assertFalse(self.runtime.validate(outside["action_id"], outside["content_hash"])["ok"])
        mismatch = self.component_action("test.core.mismatch", [{"id": "constant", "component": "core.constant", "inputs": {"value": "not integer"}, "output_schema": {"type": "object", "properties": {"value": {"type": "integer"}}}}], {"$step": "constant.value"})
        self.assertFalse(self.runtime.validate(mismatch["action_id"], mismatch["content_hash"])["ok"])
        choice = self.component_action("test.core.choice", [{"id": "choice", "component": "core.user-action", "inputs": {"prompt": "Choose a branch", "options": [{"label": "First", "value": "first"}, {"label": "Second", "value": "second"}], "test_choice": 0}}], {"$step": "choice.value"}, ["pure", "human-input"])
        self.assertTrue(self.runtime.validate(choice["action_id"], choice["content_hash"])["ok"])
        run = self.runtime.call(choice["action_id"], {}, "actual-choice", choice["content_hash"])
        deadline = time.time() + 10
        while not pending_choices(self.runtime, run["run_id"])["requests"]:
            self.assertLess(time.time(), deadline)
            time.sleep(0.05)
        request = pending_choices(self.runtime, run["run_id"])["requests"][0]
        self.assertEqual(self.runtime.get(run["run_id"])["state"], "running")
        with self.assertRaises(ValueError):
            answer_choice(self.runtime, run["run_id"], request["request_id"], True)
        answer_choice(self.runtime, run["run_id"], request["request_id"], 1)
        self.assertEqual(self.runtime.wait(run["run_id"])["output"], {"value": "second"})
        outer = self.runtime.graph_save({"action_id": "test.core.choice.outer", "nodes": [{"id": "child", "action_id": choice["action_id"], "content_hash": choice["content_hash"], "parameters": {}}], "edges": [], "output_node": "child"})
        self.assertTrue(self.runtime.validate(outer["action_id"], outer["content_hash"])["ok"])
        run = self.runtime.call(outer["action_id"], {}, "outer-choice", outer["content_hash"])
        deadline = time.time() + 10
        while not pending_choices(self.runtime, run["run_id"])["requests"]:
            self.assertLess(time.time(), deadline)
            time.sleep(0.05)
        request = pending_choices(self.runtime, run["run_id"])["requests"][0]
        self.assertNotEqual(request["run_id"], run["run_id"])
        answer_choice(self.runtime, request["run_id"], request["request_id"], 0)
        self.assertEqual(self.runtime.wait(run["run_id"])["output"], {"value": "first"})

    def test_explicit_cast_modules_and_optional_input(self):
        for name in ["core.cast.integer-to-string", "core.cast.string-to-integer", "core.cast.string-to-float"]:
            self.assertTrue(self.runtime.validate(name, self.runtime.definition(name)["content_hash"])["ok"])
        self.assertEqual(self.call("core.cast.integer-to-string", {"value": 2**63 - 1}, "int-string")["output"], {"value": str(2**63 - 1)})
        self.assertEqual(self.call("core.cast.string-to-integer", {"value": str(-(2**63))}, "string-int")["output"], {"value": -(2**63)})
        omitted = self.call("core.cast.string-to-float", {"value": "2.5"}, "optional-omitted")
        self.assertEqual(omitted["output"], {"value": 2.5})
        self.assertNotIn("trim", omitted["inputs"])
        self.assertEqual(self.call("core.cast.string-to-float", {"value": " 2.5 ", "trim": True}, "optional-set")["output"], {"value": 2.5})
        for index, value in enumerate(["NaN", "Infinity", "1e9999", "1e-9999", "1,5", " 2.5 ", "true", ""]):
            result = self.call("core.cast.string-to-float", {"value": value}, "invalid-float-" + str(index))
            self.assertEqual(result["state"], "failed", value)
        self.assertEqual(self.call("core.cast.string-to-integer", {"value": str(2**63)}, "cast-overflow")["state"], "failed")
        names = ["test.fixture.add", "core.cast.integer-to-string", "core.cast.string-to-float"]
        nodes = [{"id": "cast_" + str(index), "action_id": name,
                  "content_hash": self.runtime.definition(name)["content_hash"],
                  "parameters": {"left": 2, "right": 3} if index == 0 else {}} for index, name in enumerate(names)]
        graph = {"action_id": "test.graph.casts", "nodes": nodes, "edges": [
            {"source": "cast_0", "output": "sum", "target": "cast_1", "input": "value"},
            {"source": "cast_1", "output": "value", "target": "cast_2", "input": "value"}], "output_node": "cast_2"}
        definition = self.runtime.graph_save(graph)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {}, "cast-chain")["output"], {"value": 5.0})

    def test_graph_typed_connections_compile_and_execute(self):
        child = self.runtime.definition("test.fixture.add")
        graph = {"action_id": "test.graph.add", "name": "Addition graph", "nodes": [
            {"id": "first", "action_id": child["action_id"], "content_hash": child["content_hash"], "parameters": {"left": 2, "right": 3}},
            {"id": "second", "action_id": child["action_id"], "content_hash": child["content_hash"], "parameters": {"right": 4}}],
            "edges": [{"source": "first", "output": "sum", "target": "second", "input": "left"}], "output_node": "second"}
        definition = self.runtime.graph_save(graph)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {})["output"], {"sum": 9})
        invalid = json.loads(json.dumps(graph))
        invalid["edges"].append({"source": "second", "output": "sum", "target": "first", "input": "left"})
        with self.assertRaisesRegex(ValueError, "cycle"):
            self.runtime.graph_definition(invalid)
        invalid = json.loads(json.dumps(graph))
        invalid["edges"][0]["input"] = "missing"
        with self.assertRaisesRegex(ValueError, "ports"):
            self.runtime.graph_definition(invalid)

    def test_unknown_workspace_and_unsupported_platform(self):
        unconfigured = ModuleRuntime(self.directory / "other")
        self.assertEqual(unconfigured.availability("core.date.parse")["state"], "blocked")
        with self.assertRaises(PermissionError):
            unconfigured.call("core.date.parse", {"value": "2026-10-08"}, "blocked", unconfigured.definition("core.date.parse")["content_hash"])

    def test_module_set_export_import_selective_load_and_unload(self):
        child = self.runtime.definition("test.fixture.add")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "optional.math.add", "version": 1,
            "description": "Optional addition", "effects": ["pure"], "input_schema": child["input_schema"], "output_schema": child["output_schema"],
            "dependencies": {child["action_id"]: child["content_hash"]}, "implementations": [{"kind": "pipeline", "platforms": [platform.system()],
                "steps": [{"id": "add", "action_id": child["action_id"], "inputs": {"left": {"$input": "left"}, "right": {"$input": "right"}}}],
                "output": {"sum": {"$step": "add.sum"}}}], "examples": [{"inputs": {"left": 1, "right": 2}, "output": {"sum": 3}}]})
        package = self.runtime.workspace() / "math.pkm-actions"
        exported = self.runtime.module_set_export("optional.math", 1, [definition["action_id"]], str(package))
        self.assertFalse(exported["host_state_exported"])
        target = ModuleRuntime(self.directory / "imported")
        target.configure_workspace(str(self.runtime.workspace()))
        self.assertFalse(target.module_set_import(str(package))["enabled"])
        self.assertNotIn(definition["action_id"], {item["action_id"] for item in target.list()})
        target.module_set_load("optional.math", 1)
        imported = target.definition(definition["action_id"])
        self.assertEqual(imported["knowledgeId"], definition["knowledgeId"])
        self.assertEqual(imported["content_hash"], definition["content_hash"])
        self.assertNotEqual(target.availability(definition["action_id"])["state"], "ready")
        target.module_set_load("optional.math", 1, False)
        self.assertNotIn(definition["action_id"], {item["action_id"] for item in target.list()})
        self.assertEqual(len(target.module_set_list()["module_sets"]), 1)
        target.module_set_remove("optional.math", 1)
        self.assertEqual(target.module_set_list()["module_sets"], [])

    def test_module_set_rejects_archive_traversal(self):
        package = self.runtime.workspace() / "unsafe.pkm-actions"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("../outside.json", "{}")
        with self.assertRaises(ValueError):
            self.runtime.module_set_import(str(package))

    def test_artifact_gc_and_originals(self):
        action = "core.artifact.write"
        self.assertTrue(self.runtime.validate(action, self.runtime.definition(action)["content_hash"])["ok"])
        result = self.call(action, {"text": "artifact fixture"}, "write")
        artifact_id = result["output"]["artifact_id"]
        managed = Path(self.runtime.artifact(artifact_id)["path"])
        self.assertTrue(managed.exists())
        original = self.runtime.workspace() / "original.txt"
        original.write_text("never delete", encoding="utf-8")
        borrowed = self.runtime.import_artifact(str(original))
        self.assertEqual(self.runtime.artifact(borrowed["artifact_id"])["ownership"], "borrowed")
        exported = self.runtime.workspace() / "exported.txt"
        self.runtime.export_artifact(artifact_id, str(exported))
        self.assertTrue(self.runtime.gc(result["run_id"], release_outputs=True)["ok"])
        self.assertFalse(managed.exists())
        self.assertEqual(original.read_text(), "never delete")
        self.assertEqual(exported.read_text(), "artifact fixture")
        self.assertTrue(self.runtime.gc(result["run_id"], release_outputs=True)["ok"])

    def grant(self, definition):
        policy = self.runtime.root / "policy.json"
        grants = json.loads(policy.read_text())["grants"] if policy.exists() else []
        grants.append({"action_id": definition["action_id"], "content_hash": definition["content_hash"], "trusted_host_execution": True})
        policy.write_text(json.dumps({"schema": "pkm.action.policy/v1", "grants": grants}))

    def test_explicit_cast_and_invalid_output(self):
        child = self.runtime.definition("test.fixture.add")
        script = self.directory / "bad.py"
        script.write_text("import json,sys\nprint(json.dumps({'sum':'wrong'}))\n")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.bad.output", "version": 1,
            "description": "Output checking", "effects": ["pure"], "input_schema": child["input_schema"], "output_schema": child["output_schema"],
            "casts": {"left": "integer"}, "implementations": [{"kind": "program", "program": "python", "args": [str(script)],
                "files": [str(script)], "platforms": [platform.system()]}], "examples": [{"inputs": {"left": "2", "right": 3}}]})
        self.grant(definition)
        self.assertFalse(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.runtime.availability(definition["action_id"])["state"], "failed")
        with self.assertRaises(ValueError):
            self.runtime.cast(definition, {"left": "2.1", "right": 3})

    @unittest.skipUnless(shutil.which("dotnet"), ".NET SDK unavailable")
    def test_csharp_to_python(self):
        child = self.runtime.definition("test.fixture.add")
        project = self.directory / "csharp"
        project.mkdir()
        (project / "test.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')
        bridge = str(Path(__file__).resolve().parents[1] / "resources" / "action_modules.py")
        source = '''using System; using System.Diagnostics; using System.Text.Json;
class Program { static void Main() {
var input=Console.In.ReadToEnd();
var info=new ProcessStartInfo(Environment.GetEnvironmentVariable("TEST_PYTHON"));
info.ArgumentList.Add(Environment.GetEnvironmentVariable("TEST_BRIDGE"));
info.ArgumentList.Add("--invoke"); info.ArgumentList.Add("test.fixture.add"); info.ArgumentList.Add("csharp-child");
info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true; info.UseShellExecute=false;
using(var process=Process.Start(info)){ process.StandardInput.Write(input); process.StandardInput.Close();
var output=process.StandardOutput.ReadToEnd(); process.WaitForExit(); if(process.ExitCode!=0) throw new Exception("Child failed"); Console.Write(output); }
} }'''
        (project / "Program.cs").write_text(source)
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.csharp.python", "version": 1,
            "description": "C sharp invokes Python Action", "effects": ["pure"], "input_schema": child["input_schema"], "output_schema": child["output_schema"],
            "dependencies": {child["action_id"]: child["content_hash"]}, "implementations": [{"kind": "program", "program": "dotnet",
                "args": ["${build_dir}/test.dll"], "platforms": [platform.system()],
                "build": {"program": "dotnet", "args": ["build", str(project / "test.csproj"), "--ignore-failed-sources", "--nologo", "-v:q", "-o", "${build_dir}"],
                    "source_files": [str(project / "test.csproj"), str(project / "Program.cs")],
                    "outputs": ["test.dll", "test.runtimeconfig.json", "test.deps.json"]}}],
            "examples": [{"inputs": {"left": 20, "right": 22}, "output": {"sum": 42}}]})
        self.grant(definition)
        self.assertEqual(self.runtime.availability(definition["action_id"])["state"], "needs_build")
        previous = {key: os.environ.get(key) for key in ["TEST_PYTHON", "TEST_BRIDGE"]}
        os.environ.update({"TEST_PYTHON": sys.executable, "TEST_BRIDGE": bridge})
        try:
            self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
            self.assertEqual(self.call(definition["action_id"], {"left": 10, "right": 30})["output"], {"sum": 40})
            artifact = Path(self.runtime.build_state(definition)["directory"]) / "test.dll"
            artifact.write_bytes(b"tampered")
            self.assertEqual(self.runtime.availability(definition["action_id"])["state"], "needs_build")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_mcp_implementation(self):
        from fastmcp import Client
        from fastmcp.client.transports import StdioTransport
        script = self.directory / "fixture_server.py"
        script.write_text('from fastmcp import FastMCP\nm=FastMCP("fixture")\n@m.tool(annotations={"readOnlyHint":True})\ndef add(left:int,right:int)->dict:\n return {"sum":left+right}\nm.run()\n')

        async def contracts():
            async with Client(StdioTransport(sys.executable, [str(script)])) as client:
                return (await client.list_tools())[0]

        tool = asyncio.run(contracts())
        child = self.runtime.definition("test.fixture.add")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "test.mcp.add", "version": 1,
            "description": "Pinned MCP backed Action", "effects": ["pure"], "input_schema": child["input_schema"], "output_schema": child["output_schema"],
            "implementations": [{"kind": "mcp", "platforms": [platform.system()], "files": [str(script)],
                "server": {"program": "python", "args": [str(script)]}, "tool": "add", "read_only": True,
                "input_schema_hash": digest(tool.inputSchema), "output_schema_hash": digest(tool.outputSchema)}],
            "examples": [{"inputs": {"left": 3, "right": 4}, "output": {"sum": 7}}]})
        self.grant(definition)
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        self.assertEqual(self.call(definition["action_id"], {"left": 8, "right": 9})["output"], {"sum": 17})


class ValidationQueueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.runtime = ModuleRuntime(self.directory / "store")
        self.runtime.configure_workspace(str(self.directory / "workspace"))
        register_test_add(self.runtime)

    def enqueue(self, name, priority="demand"):
        return self.runtime.queue_enqueue(name, self.runtime.definition(name)["content_hash"], priority, launch=False)

    def finish(self):
        self.runtime.queue_start()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = self.runtime.queue_status()
            if not status["worker_pid"]:
                return status
            time.sleep(0.1)
        self.fail("Background validation worker did not finish.")

    def test_demand_priority_deduplication_and_background_execution(self):
        first = self.enqueue("core.date.parse", "idle")
        second = self.enqueue("test.fixture.add", "graph")
        duplicate = self.enqueue("test.fixture.add", "demand")
        self.assertEqual(second["job_id"], duplicate["job_id"])
        status = self.finish()
        self.assertEqual(status["counts"], {"succeeded": 2})
        jobs = {job["job_id"]: job for job in status["jobs"]}
        self.assertLess(jobs[second["job_id"]]["started_at"], jobs[first["job_id"]]["started_at"])
        self.assertEqual(self.runtime.availability("test.fixture.add")["state"], "ready")

    def test_queued_cancellation_and_explicit_effect_consent(self):
        result = self.enqueue("test.fixture.add")
        self.runtime.queue_cancel(result["job_id"])
        self.assertEqual(self.finish()["counts"], {"cancelled": 1})
        with self.assertRaises(PermissionError):
            self.enqueue("core.artifact.write", "idle")


if __name__ == "__main__":
    unittest.main()