import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "resources" / "recipe_test_gate.py"
spec = importlib.util.spec_from_file_location("test_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class TestRecipeTestGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def config(self, command, runner="pytest", **kwargs):
        return dict(command=command, runner=runner, cwd=str(self.root),
                    artifact_directory=str(self.root / "artifacts"), **kwargs)

    def fake(self, xml, exit_code=0, coverage=None):
        script = self.root / "runner.py"
        script.write_text(
            "import sys\nfrom pathlib import Path\n"
            f"xml={xml!r}\n"
            "for arg in sys.argv[1:]:\n"
            " if arg.startswith('--junitxml='): Path(arg.split('=',1)[1]).write_text(xml)\n"
            + (f" if arg.startswith('--cov-report=json:'): Path(arg.split('json:',1)[1]).write_text({json.dumps(coverage)!r})\n" if coverage is not None else "")
            + f"print('full log retained')\nsys.exit({exit_code})\n"
        )
        return [sys.executable, str(script)]

    def test_success_and_artifacts(self):
        result = gate.run_gate(self.config(self.fake('<testsuite><testcase name="ok"/></testsuite>')))
        self.assertTrue(result["all_passed"])
        self.assertEqual(result["failures"], [])
        self.assertIn("full log retained", Path(result["artifacts"]["log"]).read_text())
        self.assertTrue(Path(result["artifacts"]["result"]).exists())

    def test_failures_even_with_zero_exit(self):
        result = gate.run_gate(self.config(self.fake(
            '<testsuite><testcase classname="a" name="bad"><failure message="wrong">trace</failure></testcase></testsuite>'
        )))
        self.assertFalse(result["all_passed"])
        self.assertEqual(result["failures"][0]["case_id"], "a::bad")

    def test_empty_skipped_corrupt_and_suite_error(self):
        for xml in ('<testsuite/>', '<testsuite><testcase><skipped/></testcase></testsuite>',
                    'broken', '<wrong/>', '<testsuite errors="1"/>',
                    '<testsuite><error message="setup">trace</error></testsuite>'):
            with self.subTest(xml=xml):
                self.assertFalse(gate.run_gate(self.config(self.fake(xml)))["all_passed"])

    def test_exit_startup_timeout_and_missing_report(self):
        for command, kwargs in [
            (self.fake('<testsuite><testcase/></testsuite>', 3), {}),
            (["/nonexistent/pkm-test-runner"], {}),
            ([sys.executable, "-c", "import time; time.sleep(10)"], {"timeout_seconds": .05}),
            ([sys.executable, "-c", "pass"], {}),
        ]:
            with self.subTest(command=command):
                result = gate.run_gate(self.config(command, **kwargs))
                self.assertFalse(result["all_passed"])
                self.assertTrue(result["gate_failures"])

    def test_coverage_gate(self):
        for coverage, expected in [(None, False), ({}, False),
                                   ({"totals": {"percent_covered": 99}}, False),
                                   ({"totals": {"percent_covered": 100}}, True),
                                   ({"totals": {"percent_covered": float("nan")}}, False)]:
            result = gate.run_gate(self.config(self.fake(
                '<testsuite><testcase/></testsuite>', coverage=coverage), coverage_threshold=100))
            self.assertEqual(result["all_passed"], expected)

    def test_native_node_reporter(self):
        for body, expected in [("console.log('success log');", True),
                               ("throw new Error('intentional failure');", False)]:
            script = self.root / "test.cjs"
            script.write_text(body)
            result = gate.run_gate(self.config(["node", str(script)], runner="node"))
            self.assertEqual(result["all_passed"], expected)
            self.assertGreater(result["tests"], 0)

    def test_invalid_configuration_and_cli(self):
        for kwargs in [{"runner": "unknown"}, {"command": "shell text"},
                       {"timeout_seconds": 0}, {"coverage_threshold": float("nan")},
                       {"runner": "node", "coverage_threshold": 100}]:
            config = self.config(["node"])
            config.update(kwargs)
            with self.assertRaises(ValueError):
                gate.run_gate(config)
        config_path = self.root / "config.json"
        config_path.write_text('[]')
        completed = subprocess.run([sys.executable, str(SCRIPT), "--config", str(config_path)],
                                   capture_output=True, text=True)
        self.assertEqual(completed.returncode, 2)
        self.assertFalse(json.loads(completed.stdout)["all_passed"])

    def test_compact_failures_retain_full_artifact(self):
        result = {"failures": [{"case_id": str(i), "message": "a" * 1000, "details": "b" * 4000}
                               for i in range(15)]}
        compact = gate.compact_result(result)
        self.assertEqual(compact["failure_count"], 15)
        self.assertEqual(len(compact["failures"]), 10)
        self.assertTrue(compact["diagnostics_truncated"])
        self.assertEqual(len(result["failures"][0]["details"]), 4000)


if __name__ == "__main__":
    unittest.main()
