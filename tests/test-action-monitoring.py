"""Read-only status adapters and original-Run monitoring; no cloud authentication or requests."""

import asyncio
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_azuredevops import query, cli_failure, status_definition, execute
from action_modules import ModuleRuntime
from action_monitoring import append_event, event_page
from action_runtime import ActionRuntime, register_action_tools
from fastmcp import Client, FastMCP


class StatusAdapter(unittest.TestCase):
    def test_self_contained_capture_bounds_timeout_and_revision_factory(self):
        result = execute([sys.executable, "-c", "print('x'*70000)"])
        self.assertTrue(result["stdout_truncated"])
        self.assertEqual(len(result["stdout"]), 65536)
        self.assertEqual(cli_failure(result)["failure"]["code"], "response_too_large")
        failed = execute([sys.executable, "-c", "import sys;sys.stderr.write('denied');sys.exit(3)"])
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["stderr"], "denied")
        missing = execute([str(Path(tempfile.gettempdir()) / "pkm-fixture-no-such-azure-cli")])
        self.assertFalse(missing["ok"])
        self.assertTrue(missing["stderr"])
        process = Mock(pid=123, returncode=-9)
        process.wait.side_effect = [subprocess.TimeoutExpired("az", 20), -9]
        with patch("action_azuredevops.subprocess.Popen", return_value=process), \
                patch("action_azuredevops.os.name", "posix"), \
                patch("action_azuredevops.os.killpg") as kill:
            result = execute(["az", "rest"])
        kill.assert_called_once_with(123, signal.SIGKILL)
        self.assertTrue(result["timed_out"])
        self.assertFalse(result["ok"])
        examples = [{"inputs": {"organization": "https://example.visualstudio.com", "project": "Fixture", "run_id": "1"}}]
        definition = status_definition("fixture.status.revision", version=3, examples=examples)
        self.assertEqual(definition["version"], 3)
        self.assertEqual(definition["examples"], examples)
        self.assertEqual(definition["implementations"][0]["platforms"], [platform.system()])
        self.assertEqual(definition["implementations"][0]["program"], sys.executable)
        source = Path(__file__).resolve().parents[1] / "resources" / "action_azuredevops.py"
        self.assertNotIn("recipe_runtime", source.read_text())

    def test_real_cli_adapter_register_qualify_and_monitor_without_cloud(self):
        with tempfile.TemporaryDirectory(prefix="pkm-ado-cli-fixture-") as directory:
            root = Path(directory)
            calls = root / "calls.jsonl"
            executable = root / "az"
            executable.write_text("#!" + sys.executable + "\nimport json,sys\nfrom pathlib import Path\n"
                "args=sys.argv[1:]\n"
                f"with Path({str(calls)!r}).open('a') as stream: stream.write(json.dumps(args)+'\\n')\n"
                "if args[0]=='rest' and '/timeline?' not in args[args.index('--url')+1]:\n"
                "    remote=args[args.index('--url')+1].split('/builds/')[1].split('?')[0]\n"
                "    print(json.dumps({'id':remote,'definition':{'id':50205},"
                "'status':'completed','result':'succeeded'}))\n"
                "elif args[0]=='rest' and args[args.index('--method')+1]=='GET':\n"
                "    print(json.dumps({'records':[]}))\n"
                "else: raise ValueError('No mutations permitted by fixture')\n")
            executable.chmod(0o700)
            runtime = ModuleRuntime(root / "store")
            runtime.configure_workspace(str(root / "workspace"))
            with patch("action_azuredevops.shutil.which", return_value=str(executable)):
                definition = status_definition("fixture.ado.status")
            inputs = {"organization": "https://example.visualstudio.com", "project": "Fixture", "run_id": "900719925474099312345"}
            definition["examples"] = [{"inputs": inputs}]
            definition = runtime.register(definition)
            (runtime.root / "policy.json").write_text(json.dumps({"grants": [{
                "action_id": definition["action_id"], "content_hash": definition["content_hash"], "trusted_host_execution": True}]}))
            self.assertTrue(runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
            monitor = runtime.template_create("fixture.ado.monitor", {
                "template_id": "monitor", "query_action_id": definition["action_id"], "query_revision": definition["content_hash"],
                "query_inputs": inputs, "interval_seconds": 0.1, "timeout_seconds": 20, "max_iterations": 2})
            self.assertTrue(runtime.validate(monitor["action_id"], monitor["content_hash"])["ok"])
            run = runtime.call(monitor["action_id"], {}, "fixture-ado", monitor["content_hash"])
            completed = runtime.wait(run["run_id"])
            self.assertEqual(completed["state"], "succeeded", completed)
            self.assertEqual(completed["output"]["stop_reason"], "remote_completed")
            self.assertEqual(completed["output"]["remote_id"], inputs["run_id"])
            actual_calls = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertTrue(actual_calls)
            self.assertTrue(all(argv[0] == "rest" and argv[argv.index("--method") + 1] == "GET"
                                for argv in actual_calls))

    def test_all_terminal_results_running_tasks_and_precise_string_identity(self):
        remote = "900719925474099312345"
        inputs = {"organization": "https://example.visualstudio.com", "project": "Test Project", "run_id": remote}
        for result in ["succeeded", "failed", "canceled", "partiallySucceeded"]:
            calls = []

            def execute(argv):
                calls.append(argv)
                value = ({"id": remote, "definition": {"id": 50205}, "status": "completed", "result": result}
                         if "/timeline?" not in argv[argv.index("--url") + 1] else {"records": [
                             {"name": "task", "state": "completed", "result": "failed"}]})
                return {"ok": True, "stdout": json.dumps(value)}

            output = query(inputs, execute, executable="az")["output"]
            self.assertTrue(output["terminal"])
            self.assertEqual(output["result"], result)
            self.assertEqual(output["remote_id"], remote)
            self.assertIn(remote, output["url"])
            self.assertEqual(output["tasks"][0]["result"], "failed")
            self.assertEqual(calls[0][1], "rest")
            self.assertIn("--method", calls[1])
            self.assertIn("GET", calls[1])

    def test_errors_do_not_export_cli_secrets_or_switch_identity(self):
        for text, code in [("401 az login SECRET", "authentication_failed"),
                           ("403 access denied SECRET", "permission_denied"),
                           ("404 not found SECRET", "not_found"),
                           ("TF401019 SECRET", "access_or_not_found"),
                           ("network connection SECRET", "network_error"),
                           ("unknown SECRET", "cli_failed")]:
            result = cli_failure({"ok": False, "stderr": text})
            self.assertFalse(result["ok"])
            self.assertEqual(result["failure"]["code"], code)
            self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(cli_failure({"timed_out": True})["failure"]["code"], "network_timeout")
        with patch("action_azuredevops.shutil.which", return_value=None):
            result = query({"organization": "https://example.visualstudio.com", "project": "Test", "run_id": "1"})
            self.assertEqual(result["failure"]["code"], "missing_toolchain")

    def test_input_and_response_guards(self):
        inputs = {"organization": "https://example.visualstudio.com", "project": "Test", "run_id": "1"}
        self.assertEqual(query({**inputs, "run_id": 1})["failure"]["code"], "invalid_input")
        self.assertEqual(query({**inputs, "organization": "https://other.example"})["failure"]["code"], "invalid_input")
        result = query(inputs, lambda argv: {"ok": True, "stdout": '{"id":"2"}'}, executable="az")
        self.assertEqual(result["failure"]["code"], "invalid_response")


class Monitoring(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pkm-action-monitoring-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = ModuleRuntime(self.root / "store")
        self.runtime.configure_workspace(str(self.root / "workspace"))
        self.state_file = self.root / "fixture.json"
        self.script = self.root / "query.py"
        self.script.write_text(
            "import json,sys\nfrom pathlib import Path\n"
            "v=json.load(sys.stdin); p=Path(v['fixture']); s=json.loads(p.read_text())\n"
            "if s.get('failure'): print(json.dumps({'ok':False,'failure':s['failure']})); sys.exit(0)\n"
            "print(json.dumps({'ok':True,'output':{'remote_id':v['run_id'],'terminal':s['terminal'],"
            "'result':s['result'],'status':'completed' if s['terminal'] else 'inProgress'}}))\n")
        self.inputs = {"run_id": "900719925474099312345", "fixture": str(self.state_file)}
        properties = {"remote_id": {"type": "string"}, "terminal": {"type": "boolean"},
                      "result": {"type": ["string", "null"]}, "status": {"type": "string"}}
        self.set_remote(True, "succeeded")
        self.query = self.runtime.register({
            "schema": "pkm.action.definition/v1", "action_id": "fixture.remote.status", "version": 1,
            "effects": ["remote-read"],
            "input_schema": {"type": "object", "properties": {"run_id": {"type": "string"}, "fixture": {"type": "string"}},
                             "required": ["run_id", "fixture"]},
            "output_schema": {"type": "object", "properties": properties, "required": list(properties)},
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": "python",
                                 "args": [str(self.script)], "files": [str(self.script)],
                                 "result_protocol": "pkm.action.result/v1"}],
            "examples": [{"inputs": self.inputs}]})
        (self.runtime.root / "policy.json").write_text(json.dumps({"grants": [{
            "action_id": self.query["action_id"], "content_hash": self.query["content_hash"], "trusted_host_execution": True}]}))
        self.assertTrue(self.runtime.validate(self.query["action_id"], self.query["content_hash"])["ok"])

    def set_remote(self, terminal, result, failure=None):
        self.state_file.write_text(json.dumps({"terminal": terminal, "result": result, "failure": failure}))

    def monitor(self, timeout=20, iterations=10, interval=0.1):
        definition = self.runtime.template_create("fixture.remote.monitor", {
            "template_id": "monitor", "query_action_id": self.query["action_id"],
            "query_revision": self.query["content_hash"], "query_inputs": self.inputs,
            "interval_seconds": interval, "timeout_seconds": timeout, "max_iterations": iterations})
        self.assertTrue(self.runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        return definition

    def launch(self, definition):
        return self.runtime.call(definition["action_id"], {}, "same-logical-monitor", definition["content_hash"])

    def state(self, run_id, predicate, runtime=None, timeout=30):
        runtime = runtime or self.runtime
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            runtime.recovery.safety_scan()
            value = runtime.get(run_id)
            if predicate(value):
                return value
            time.sleep(0.025)
        self.fail(str(value))

    def test_failed_remote_terminal_stops_and_blocks_recipe_continuation(self):
        definition = self.monitor()
        self.set_remote(True, "failed")
        run = self.launch(definition)
        completed = self.state(run["run_id"], lambda value: value["state"] not in {"running", "waiting"})
        self.assertEqual(completed["state"], "failed", completed)
        self.assertEqual(completed["output"]["stop_reason"], "remote_completed")
        self.assertEqual(completed["output"]["remote_result"], "failed")
        self.assertFalse(completed["output"]["remote_may_still_be_active"])
        self.assertEqual(completed["output"]["attempts"], 1)
        self.assertEqual(completed["output"]["remote_id"], self.inputs["run_id"])

    def test_timeout_is_observer_failure_not_remote_failure_or_cancellation(self):
        definition = self.monitor(iterations=1)
        self.set_remote(False, None)
        run = self.launch(definition)
        completed = self.state(run["run_id"], lambda value: value["state"] not in {"running", "waiting"})
        self.assertEqual(completed["state"], "failed", completed)
        self.assertEqual(completed["output"]["stop_reason"], "observation_timed_out")
        self.assertTrue(completed["output"]["remote_may_still_be_active"])
        self.assertIsNone(completed["output"]["remote_result"])
        self.assertEqual(json.loads(self.state_file.read_text())["terminal"], False)

    def test_query_auth_failure_is_typed_and_not_retried(self):
        definition = self.monitor()
        self.set_remote(False, None, {"code": "authentication_failed", "message": "Operator login required", "blocked": True})
        run = self.launch(definition)
        completed = self.state(run["run_id"], lambda value: value["state"] not in {"running", "waiting"})
        self.assertEqual(completed["state"], "failed", completed)
        self.assertEqual(completed["output"]["stop_reason"], "query_failed")
        self.assertEqual(completed["output"]["failure"]["code"], "authentication_failed")
        self.assertTrue(completed["output"]["failure"]["blocked"])
        self.assertEqual(completed["output"]["attempts"], 1)

    def test_new_api_process_resumes_same_monitor_deadline_and_replays_events(self):
        definition = self.monitor(interval=0.2)
        self.set_remote(False, None)
        run = self.launch(definition)
        waiting = self.state(run["run_id"], lambda value: value["state"] == "waiting" and value.get("monitor", {}).get("attempts") == 1)
        deadline = waiting["monitor"]["observation_deadline"]
        cursor = event_page(waiting)["next_sequence"]
        process = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "resources/action_modules.py"),
            "--api", str(self.runtime.store)], input=json.dumps({"method": "run", "params": {"run_id": run["run_id"]}}),
            text=True, capture_output=True, timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["monitor"]["observation_deadline"], deadline)
        self.set_remote(True, "succeeded")
        restarted = ModuleRuntime(self.runtime.store)
        completed = self.state(run["run_id"], lambda value: value["state"] not in {"running", "waiting"}, restarted)
        self.assertEqual(completed["state"], "succeeded", completed)
        self.assertEqual(completed["monitor"]["observation_deadline"], deadline)
        self.assertEqual(completed["run_id"], self.launch(definition)["run_id"])
        page = event_page(completed, cursor)
        self.assertTrue(any(event["kind"] == "remote_completed" for event in page["events"]))
        self.assertEqual(event_page(restarted.get(run["run_id"]), cursor), page)

    def test_cancel_stops_observer_without_mutating_remote_and_delivers_notification(self):
        definition = self.monitor(interval=30)
        self.set_remote(False, None)
        run = self.launch(definition)
        self.state(run["run_id"], lambda value: value["state"] == "waiting" and value.get("monitor", {}).get("attempts") == 1)
        self.runtime.cancel(run["run_id"])
        completed = self.runtime.get(run["run_id"])
        self.assertEqual(completed["state"], "cancelled", completed)
        self.assertEqual(completed["monitor"]["stop_reason"], "cancelled")
        self.assertTrue(completed["monitor"]["remote_may_still_be_active"])
        self.assertFalse(json.loads(self.state_file.read_text())["terminal"])
        self.assertEqual(event_page(completed)["events"][-1]["kind"], "cancelled")

    def test_active_mcp_wait_delivers_events_and_reconnect_cursor(self):
        definition = self.monitor(interval=30)
        self.set_remote(False, None)

        async def exercise():
            server = FastMCP("monitoring-fixture")
            runtime = ActionRuntime(self.runtime.store)
            register_action_tools(server, self.runtime.store, runtime)
            async with Client(server) as client:
                run = (await client.call_tool("action_call", {"action_id": definition["action_id"],
                    "inputs": {}, "idempotency_key": "mcp-monitor", "content_hash": definition["content_hash"]})).structured_content
                update = (await client.call_tool("action_run_wait", {
                    "run_id": run["run_id"], "wait_seconds": 10, "after_sequence": 0})).structured_content
                self.assertTrue(update["event_update"], update)
                cursor = update["event_delivery"]["next_sequence"]
                replay = (await client.call_tool("action_run_events", {"run_id": run["run_id"], "after_sequence": 0})).structured_content
                self.assertGreaterEqual(replay["next_sequence"], cursor)
                await client.call_tool("action_run_cancel", {"run_id": run["run_id"]})
                self.state(run["run_id"], lambda value: value["state"] not in {"running", "waiting"})
                scheduler = runtime._scheduler
                if scheduler:
                    scheduler.join(timeout=5)
                    self.assertFalse(scheduler.is_alive())
        asyncio.run(exercise())

    def test_event_retention_gap_is_explicit(self):
        record = {"run_id": "fixture"}
        for index in range(260):
            append_event(record, "observing", {"index": index})
        page = event_page(record, 0)
        self.assertTrue(page["gap"])
        self.assertEqual(len(page["events"]), 256)
        self.assertFalse(event_page(record, 259)["gap"])


if __name__ == "__main__":
    unittest.main()
