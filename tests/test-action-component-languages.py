"""Stateless core components behave identically in their Python, JavaScript and TypeScript implementations."""

import math
import os
import platform
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_components import (COMPONENT_LANGUAGES, STATELESS_COMPONENTS, component_definitions, component_scripts,
                               run_stateless_component, validate_steps)
from action_modules import ModuleRuntime

LANGUAGES = list(COMPONENT_LANGUAGES)


class FakeRuntime:
    def __init__(self, workspace, resources):
        self._workspace = Path(workspace).resolve()
        self._resources = Path(resources).resolve()

    def workspace(self):
        return self._workspace

    def resolve_program(self, name):
        executable = shutil.which(name)
        if not executable:
            raise PermissionError("Missing Action toolchain: " + name)
        return executable

    def resource_path(self, definition, reference, field):
        return (self._resources / reference.split("/")[-1]).resolve()


MATH_CASES = [
    ("{0} x {1} + {2} * log {3}", {"input_0": 2, "input_1": 3, "input_2": 4, "input_3": math.e}),
    ("max({0}, {1}) + sqrt(16) + 2^3", {"input_0": 1, "input_1": 5}),
    ("sin(pi / 2) + log(8, 2)", {}), ("7 // 2", {}), ("-7 // 2", {}), ("-7 % 3", {}), ("7 % -3", {}),
    ("7.5 % 2", {}), ("-2 ** 2", {}), ("2 ** -1", {}), ("2 ** 10", {}), ("4 / 2", {}), ("{0} / 2", {"input_0": 4.0}),
    ("round(2.5) + round(3.5)", {}), ("round(1.25, 1)", {}), ("ceil(1.2) + floor(-1.2) + trunc(-1.7)", {}),
    ("abs(-3) + fabs(-3)", {}), ("hypot(3, 4)", {}), ("fmod(-7, 3)", {}), ("copysign(2, -0.0)", {}),
    ("degrees(pi) + radians(180)", {}), ("min(3, 1.5, 2)", {}), ("log10 100 + log2 8", {}), ("tau - 2 * pi", {}),
    ("atan2(1, 1)", {}), ("expm1(0) + log1p(0)", {}), ("((1 + 2) * (3 - 4)) / 5", {}), ("+-+3", {}),
    # Rejected input is a ValueError in every implementation.
    ("{32}", {}), ("{0}", {}), ("log(-1)", {}), ("1/0", {}), ("1 // 0", {}), ("1.0 % 0", {}), ("2**101", {}),
    ("__import__('os')", {}), ("math.log(2)", {}), ("[1][0]", {}), ("1e101", {}), ("sqrt(value=4)", {}),
    ("sqrt(-1)", {}), ("asin(2)", {}), ("min(1)", {}), ("exp(1000)", {}), ("(-8) ** (1/3)", {}), ("0 ** -1", {}),
    ("1 +", {}), ("unknown(1)", {}), ("1 < 2", {}), ("010", {}), ("round(2.5, 1.0)", {}),
    ("+".join(["1"] * 70), {}),
]
CAST_CASES = [
    ("12", "integer", False), (" 12 ", "integer", True), (" 12 ", "integer", False), ("-0", "integer", False),
    ("1.5", "integer", False), (3.0, "integer", False), (3.5, "integer", False), ("9223372036854775808", "integer", False),
    ("1.5", "number", False), ("1e3", "number", False), ("1e400", "number", False), ("1e-400", "number", False),
    ("0e5", "number", False), (2, "number", False), (2.5, "number", False), (True, "number", False),
    ("true", "boolean", False), ("True", "boolean", False), (False, "boolean", False),
    ('{"a": 1}', "object", False), ("[1, 2]", "array", False), ("null", "null", False), ("[1]", "object", False),
    ("{bad", "object", False), ({"a": [1, "x"], "b": None}, "string", False), (2.0, "string", False),
    (1e16, "string", False), (1.5e-7, "string", False), (12, "string", False), ("text", "string", False),
    ([1, True, None], "string", False), (1, "unknown", False),
]


class LanguageParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("node"):
            raise unittest.SkipTest("Node.js is required for JavaScript/TypeScript component parity.")
        missing = [str(path) for path in component_scripts().values() if not path.is_file()]
        if missing:
            raise AssertionError("Build the extension first; missing component implementations: " + ", ".join(missing))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-component-languages-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        (root / "workspace" / "sub").mkdir(parents=True)
        (root / "workspace" / "exists.txt").write_text("x")
        (root / "outside").mkdir()
        (root / "outside" / "secret.txt").write_text("x")
        (root / "resources").mkdir()
        (root / "resources" / "asset.txt").write_text("x")
        self.root = root
        self.runtime = FakeRuntime(root / "workspace", root / "workspace" / "sub")
        self.record = {"definition": {"action_id": "test.parity"}}

    def outcome(self, name, values, language):
        try:
            return "ok", run_stateless_component(self.runtime, self.record, "step", name, dict(values), language)
        except (PermissionError, KeyError, ValueError) as error:
            return next(kind.__name__ for kind in (PermissionError, KeyError, ValueError) if isinstance(error, kind)), None

    def assertSame(self, name, values):
        expected = self.outcome(name, values, "python")
        for language in LANGUAGES[1:]:
            with self.subTest(component=name, values=values, language=language):
                actual = self.outcome(name, values, language)
                self.assertEqual(actual[0], expected[0], (expected, actual))
                if expected[0] == "ok":
                    self.assertEqual(set(actual[1]), set(expected[1]))
                    for field, value in expected[1].items():
                        self.assertIs(type(actual[1][field]), type(value), (field, expected, actual))
                        if type(value) is float:
                            self.assertTrue(math.isclose(actual[1][field], value, rel_tol=1e-12, abs_tol=1e-15), (expected, actual))
                        else:
                            self.assertEqual(actual[1][field], value)

    def test_every_stateless_component_declares_three_languages_and_control_flow_stays_host(self):
        for name, definition in component_definitions().items():
            languages = [item["language"] for item in definition["component_implementations"]]
            self.assertEqual(languages, ["Python", "JavaScript", "TypeScript"] if name in STATELESS_COMPONENTS else ["Python"], name)
            self.assertEqual([item["id"] for item in definition["component_implementations"] if item["default"]], ["python"])
        with self.assertRaisesRegex(ValueError, "control-flow components run in the host"):
            validate_steps([{"id": "pause", "component": "core.sleep", "implementation": "javascript", "inputs": {"seconds": 0}}], {})
        with self.assertRaisesRegex(ValueError, "Unsupported implementation"):
            validate_steps([{"id": "value", "component": "core.constant", "implementation": "ruby", "inputs": {"value": 1}}], {})

    def test_math_expression_parity(self):
        for expression, inputs in MATH_CASES:
            self.assertSame("core.math-expression", {"expression": expression, **inputs})

    def test_cast_parity(self):
        for value, target, trim in CAST_CASES:
            self.assertSame("core.cast", {"value": value, "target_type": target, "trim": trim})

    def test_constant_and_lookup_parity(self):
        for values in [{"value": 1}, {"value": 1.5}, {"value": 2.0}, {"value": "x"}, {"value": {"a": [1, None]}}, {"value": None}]:
            self.assertSame("core.constant", values)
        for values in [{"dictionary": {"a": 1}, "key": "a"}, {"dictionary": {"a": 1}, "key": "b"},
                       {"dictionary": {}, "key": "b", "default": 2.0}, {"dictionary": {"constructor": 1}, "key": "toString"},
                       {"dictionary": {}, "key": "__proto__", "default": None}]:
            self.assertSame("core.lookup", values)

    def test_file_path_parity_and_containment(self):
        workspace = self.runtime.workspace()
        os.symlink(self.root / "outside", workspace / "escape")
        cases = ["exists.txt", "new.txt", "sub/../exists.txt", "sub/missing/../file", "../outside/secret.txt",
                 "escape/secret.txt", str(workspace / "exists.txt"), str(self.root / "outside" / "secret.txt"), ".",
                 "pkm://asset.txt"]
        for reference in cases:
            for must_exist in [False, True]:
                self.assertSame("core.file-path", {"path": reference, "must_exist": must_exist})
        self.assertSame("core.file-path", {"path": "exists.txt"})
        self.assertEqual(self.outcome("core.file-path", {"path": "sub/../exists.txt", "must_exist": True}, "typescript"),
                         ("ok", {"path": str(workspace / "exists.txt")}))

    def test_large_integers_are_rejected_instead_of_rounded(self):
        for language in LANGUAGES[1:]:
            with self.subTest(language=language), self.assertRaisesRegex(ValueError, "9007199254740991"):
                run_stateless_component(self.runtime, self.record, "step", "core.constant", {"value": 2 ** 60}, language)
            with self.subTest(language=language), self.assertRaisesRegex(ValueError, "9007199254740991"):
                run_stateless_component(self.runtime, self.record, "step", "core.cast",
                                        {"value": "9007199254740993", "target_type": "integer", "trim": False}, language)


class LanguagePipelines(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("Node.js is required for JavaScript/TypeScript component pipelines.")
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-component-pipelines-")
        self.addCleanup(self.temporary.cleanup)
        directory = Path(self.temporary.name)
        (directory / "workspace").mkdir()
        (directory / "workspace" / "data.txt").write_text("x")
        self.runtime = ModuleRuntime(directory / "store")
        self.runtime.configure_workspace(str(directory / "workspace"))

    def test_graph_selects_language_per_block_and_catalog_reports_languages(self):
        components = {item["action_id"]: item for item in self.runtime.components()}
        outputs = {}
        for language in LANGUAGES:
            graph = {"action_id": "test.languages." + language, "nodes": [
                {"id": "path", "action_id": "core.file-path", "implementation": language,
                 "content_hash": components["core.file-path"]["content_hash"], "parameters": {"path": "data.txt", "must_exist": True}},
                {"id": "math", "action_id": "core.math-expression", "implementation": language,
                 "content_hash": components["core.math-expression"]["content_hash"], "parameters": {"expression": "{0} * 2 + 1", "input_0": 20}},
                {"id": "pick", "action_id": "core.lookup", "implementation": language, "value_type": "string",
                 "content_hash": self.runtime.component("core.lookup", "string")["content_hash"],
                 "parameters": {"dictionary": {"a": "A"}, "key": "a"}}],
                "edges": [], "output_node": "path"}
            definition = self.runtime.graph_save(graph)
            steps = definition["implementations"][0]["steps"]
            self.assertEqual({step.get("implementation", "python") for step in steps}, {language})
            self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"], language)
            run = self.runtime.call(definition["action_id"], {}, "run-" + language, definition["content_hash"])
            result = self.runtime.wait(run["run_id"])
            self.assertEqual(result["state"], "succeeded", result)
            outputs[language] = result["output"]
            entry = next(item for item in self.runtime.catalog()["actions"] if item["action_id"] == definition["action_id"])
            self.assertEqual(entry["languages"], [COMPONENT_LANGUAGES[language]])
        self.assertEqual(outputs["python"], {"path": str(self.runtime.workspace() / "data.txt")})
        self.assertEqual(outputs["javascript"], outputs["python"])
        self.assertEqual(outputs["typescript"], outputs["python"])
        entry = next(item for item in self.runtime.catalog()["actions"] if item["action_id"] == "core.file-path")
        self.assertEqual(entry["languages"], ["Python", "JavaScript", "TypeScript"])
        sleep = next(item for item in self.runtime.catalog()["actions"] if item["action_id"] == "core.sleep")
        self.assertEqual(sleep["languages"], ["Python"])
        with self.assertRaisesRegex(ValueError, "Unsupported block implementation"):
            self.runtime.graph_save({"action_id": "test.languages.sleep", "nodes": [{"id": "pause", "action_id": "core.sleep",
                "implementation": "typescript", "content_hash": components["core.sleep"]["content_hash"], "parameters": {"seconds": 0}}],
                "edges": [], "output_node": "pause"})

    def test_language_failure_fails_the_run_with_the_same_error_class(self):
        components = {item["action_id"]: item for item in self.runtime.components()}
        definition = self.runtime.graph_save({"action_id": "test.languages.outside", "nodes": [
            {"id": "path", "action_id": "core.file-path", "implementation": "javascript",
             "content_hash": components["core.file-path"]["content_hash"], "parameters": {"path": "../outside.txt", "must_exist": False}}],
            "edges": [], "output_node": "path"})
        result = self.runtime.validate(definition["action_id"], definition["content_hash"])
        self.assertFalse(result["ok"])
        failed = self.runtime.get(result["evidence"][0]["run_id"])
        self.assertEqual(failed["error"], "File path is outside the Action workspace or does not exist.")


if __name__ == "__main__":
    if platform.system() == "Windows":
        sys.stdout.reconfigure(encoding="utf-8")
    unittest.main()
