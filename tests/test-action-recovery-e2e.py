"""Real worker/API/MCP boundary acceptance; all stores and effects are isolated fixtures."""

import asyncio
import datetime
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from action_modules import ModuleRuntime, process_alive
from action_recovery import ActionSuspended
from action_runtime import ActionRuntime, register_action_tools
from fastmcp import FastMCP, Client
from recipe_runtime import _atomic_write


class RecoveryE2E(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-recovery-e2e-")
        self.addCleanup(self.temporary.cleanup)
        self.store = Path(self.temporary.name) / "store"
        self.runtime = ModuleRuntime(self.store)
        self.runtime.configure_workspace(self.temporary.name)

    def pipeline(self, identifier, steps, value=None, effects=None, dependencies=None):
        return self.runtime.register({
            "schema": "pkm.action.definition/v1", "action_id": identifier, "version": 1,
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
            "output_schema": {"type": "object", "properties": {"value": {}}, "required": ["value"]},
            "effects": effects or ["pure", "human-input"], "dependencies": dependencies or {},
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": steps,
                                  "output": {"value": value if value is not None else {"$step": steps[-1]["id"] + ".value"}}}],
            "examples": [{"inputs": {}}]})

    def ready(self, definition):
        result = self.runtime.validate(definition["action_id"], definition["content_hash"])
        self.assertTrue(result["ok"], result)
        return definition

    def call(self, definition, key="launch", **kwargs):
        return self.runtime.call(definition["action_id"], {}, key, definition["content_hash"], **kwargs)

    def api(self, method, **params):
        process = subprocess.run([sys.executable, str(ROOT / "resources" / "action_modules.py"), "--api", str(self.store)],
                                 input=json.dumps({"method": method, "params": params}),
                                 text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertTrue(result.get("ok", True), result)
        return result

    def state(self, run_id, expected, timeout=15):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            result = self.runtime.get(run_id)
            if result["state"] in expected and not (
                    result["state"] == "succeeded" and not result.get("parent_run_id") and result.get("gc_state") == "pending"):
                return result
            time.sleep(0.05)
        self.fail("Run failed to reach " + str(expected) + ": " + json.dumps(result))

    def answer(self, checkpoint, answer):
        return self.api("respond_checkpoint", run_id=checkpoint["run_id"], checkpoint_id=checkpoint["checkpoint_id"],
                        resume_token=checkpoint["resume_token"], proposal_digest=checkpoint["proposal_digest"],
                        answer=answer, event_key="answer:" + checkpoint["checkpoint_id"])

    def checkpoint_definition(self, kind="approval", **extra):
        return self.ready(self.pipeline("fixture.review." + kind.replace("-", ""), [
            {"id": "review", "component": "core.checkpoint", "inputs": {
                "kind": kind, "proposal": {"revision": "pinned-1", "change": "fixture only"},
                "evidence": [{"source": "fixture", "digest": "a" * 64}],
                "answer_schema": {"type": "object", "properties": {"approved": {"type": "boolean"}},
                                  "required": ["approved"], "additionalProperties": False},
                "test_answer": {"approved": True}, **extra}}]))

    def test_five_checkpoint_kinds_release_worker_and_resume_original_after_api_restart(self):
        for kind in ["input", "approval", "artifact-review", "decision", "exception"]:
            with self.subTest(kind=kind):
                definition = self.checkpoint_definition(kind)
                run = self.call(definition, kind)
                waiting = self.state(run["run_id"], {"waiting"})
                checkpoint = waiting["checkpoint"]
                self.assertEqual(waiting["userState"], "Waiting")
                self.assertIsNone(waiting["execution"]["workerPid"])
                for _ in range(100):
                    self.runtime.get(run["run_id"])
                    if not process_alive(waiting["launcher_pid"]):
                        break
                    time.sleep(0.02)
                self.assertFalse(process_alive(waiting["launcher_pid"]))
                self.assertEqual(self.api("checkpoints", run_id=run["run_id"])["checkpoints"][0], checkpoint)
                self.assertEqual(self.api("safety_scan")["dispatched"], [])
                self.answer(checkpoint, {"approved": True})
                result = self.state(run["run_id"], {"succeeded", "outcome_unknown", "failed"})
                self.assertEqual(result["state"], "succeeded", result)
                self.assertEqual(result["output"], {"value": {"approved": True}})
                self.assertEqual(result["run_id"], run["run_id"])

    def test_duplicate_concurrent_human_responses_and_stale_proposal(self):
        run = self.call(self.checkpoint_definition())
        waiting = self.state(run["run_id"], {"waiting"})
        checkpoint = waiting["checkpoint"]
        with self.assertRaises(PermissionError):
            self.runtime.recovery.respond_checkpoint(run["run_id"], checkpoint["checkpoint_id"], "wrong",
                checkpoint["proposal_digest"], {"approved": True}, "wrong")
        with self.assertRaises(PermissionError):
            self.runtime.recovery.respond_checkpoint(run["run_id"], checkpoint["checkpoint_id"], checkpoint["resume_token"],
                "wrong", {"approved": True}, "wrong")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.answer(checkpoint, {"approved": True}), range(2)))
        self.assertEqual(sorted(result["replayed"] for result in results), [False, True])
        result = self.state(run["run_id"], {"succeeded"})
        self.assertEqual(sum(receipt["operation"] == "dispatched" for receipt in result["execution"]["receipts"]), 2)
        with self.assertRaises(ValueError):
            self.runtime.recovery.respond_checkpoint(run["run_id"], checkpoint["checkpoint_id"], checkpoint["resume_token"],
                checkpoint["proposal_digest"], {"approved": False}, "different")

    def test_loop_branch_checkpoints_preserve_prior_answers_and_exact_proposals(self):
        review = {"id": "review", "component": "core.checkpoint", "inputs": {
            "kind": "approval", "proposal": {"item": {"$var": "item"}},
            "answer_schema": {"type": "object", "properties": {"approved": {"type": "boolean"}},
                              "required": ["approved"]}, "test_answer": {"approved": True}}}
        definition = self.ready(self.pipeline("fixture.loop.review", [
            {"id": "loop", "component": "core.for", "inputs": {"items": ["first", "second", "third"],
                "max_iterations": 3, "body": [{"id": "branch", "component": "core.if-else", "inputs": {
                    "condition": True, "then_steps": [review], "then_value": {"$step": "review.value"},
                    "else_value": "must-not-execute"}}], "value": {"$step": "branch.value"}}}],
            {"$step": "loop.values"}))
        run = self.call(definition)
        proposals = []
        previous_id = None
        for item in ["first", "second", "third"]:
            until = time.monotonic() + 15
            while time.monotonic() < until:
                waiting = self.runtime.get(run["run_id"])
                checkpoint = waiting.get("checkpoint", {})
                if waiting["state"] == "waiting" and checkpoint.get("checkpoint_id") != previous_id:
                    break
                time.sleep(0.02)
            self.assertEqual(checkpoint["proposal"], {"item": item})
            proposals.append(checkpoint["proposal_digest"])
            previous_id = checkpoint["checkpoint_id"]
            self.answer(checkpoint, {"approved": True})
        result = self.state(run["run_id"], {"succeeded"})
        self.assertEqual(result["output"], {"value": [{"approved": True}] * 3})
        history = self.api("checkpoints", run_id=run["run_id"], include_history=True)["checkpoints"]
        self.assertEqual(len(history), 3)
        self.assertEqual({item["proposal_digest"] for item in history}, set(proposals))
        self.assertTrue(all(item["state"] == "resolved" and item["answer"] == {"approved": True} for item in history))

    def test_waiting_definition_authoring_stays_guarded(self):
        definition = self.checkpoint_definition()
        run = self.call(definition)
        waiting = self.state(run["run_id"], {"waiting"})
        document = self.runtime.definition_read(definition["action_id"])
        document["definition"]["version"] += 1
        for operation in [
                lambda: self.runtime.definition_save(definition["action_id"], document["definition"], definition["content_hash"]),
                lambda: self.runtime.action_delete(definition["action_id"], definition["content_hash"])]:
            with self.assertRaisesRegex(PermissionError, "waiting continuation"):
                operation()
        self.answer(waiting["checkpoint"], {"approved": True})
        self.state(run["run_id"], {"succeeded"})
        saved = self.runtime.definition_save(definition["action_id"], document["definition"], definition["content_hash"])
        self.assertEqual(saved["definition"]["version"], 2)

    def test_generic_proposal_options_are_not_interpreted_as_legacy_choices(self):
        for kind in ["input", "approval"]:
            with self.subTest(kind=kind):
                definition = self.checkpoint_definition(kind, proposal={"options": ["draft", "final"]})
                run = self.call(definition, "generic-options-" + kind)
                waiting = self.state(run["run_id"], {"waiting"})
                self.assertEqual(waiting["checkpoint"]["presentation"], "json")
                self.assertEqual(self.api("choices", run_id=run["run_id"])["requests"], [])
                self.answer(waiting["checkpoint"], {"approved": True})
                self.assertEqual(self.state(run["run_id"], {"succeeded"})["output"], {"value": {"approved": True}})

    def test_while_counter_restores_before_each_resumed_checkpoint(self):
        increment = {"id": "counter", "component": "core.constant", "inputs": {
            "value": {"$op": "add", "args": [{"$step": "counter.value"}, 1]}}}
        review = {"id": "review", "component": "core.checkpoint", "inputs": {
            "kind": "decision", "proposal": {"counter": {"$step": "counter.value"}},
            "answer_schema": {"type": "object"}, "test_answer": {}}}
        definition = self.ready(self.pipeline("fixture.while.review", [
            {"id": "counter", "component": "core.constant", "inputs": {"value": 0}},
            {"id": "loop", "component": "core.while", "inputs": {
                "condition": {"$op": "lt", "args": [{"$step": "counter.value"}, 2]},
                "body": [increment, review], "value": {"$step": "counter.value"}, "max_iterations": 2}}],
            {"$step": "loop.value"}))
        run = self.call(definition)
        previous = None
        for counter in [1, 2]:
            until = time.monotonic() + 15
            while time.monotonic() < until:
                waiting = self.runtime.get(run["run_id"])
                checkpoint = waiting.get("checkpoint", {})
                if waiting["state"] == "waiting" and checkpoint.get("checkpoint_id") != previous:
                    break
                time.sleep(0.02)
            self.assertEqual(checkpoint["proposal"], {"counter": counter})
            previous = checkpoint["checkpoint_id"]
            self.answer(checkpoint, {})
        self.assertEqual(self.state(run["run_id"], {"succeeded"})["output"], {"value": 2})

    def test_wakeup_admission_never_exceeds_eight_active_runs(self):
        definition = self.runtime.register({
            "schema": "pkm.action.definition/v1", "action_id": "fixture.admission", "version": 1,
            "input_schema": {"type": "object"}, "output_schema": {"type": "object", "properties": {
                "value": {"type": "integer"}}, "required": ["value"]}, "effects": ["pure"],
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": sys.executable,
                "args": ["-c", "import time; time.sleep(3); print('{\"value\":7}')"]}],
            "examples": [{"inputs": {}}]})
        _atomic_write(self.runtime.root / "policy.json", {"schema": "pkm.action.policy/v1", "grants": [{
            "action_id": definition["action_id"], "content_hash": definition["content_hash"], "trusted_host_execution": True}]})
        self.ready(definition)
        runs = [self.call(definition, "admission-" + str(index),
                          trigger={"kind": "timer", "at": time.time() - 1}, project_id="project-" + str(index))
                for index in range(9)]
        first = self.api("safety_scan", limit=32)
        self.assertEqual(len(first["dispatched"]), 8)
        second = self.api("safety_scan", limit=32)
        self.assertEqual(second["dispatched"], [])
        for run_id in first["dispatched"]:
            self.state(run_id, {"succeeded"})
        final = self.api("safety_scan", limit=32)
        self.assertEqual(len(final["dispatched"]), 1)
        self.assertEqual(self.state(final["dispatched"][0], {"succeeded"})["output"], {"value": 7})
        self.assertEqual({run["run_id"] for run in runs}, set(first["dispatched"] + final["dispatched"]))

    def test_cancelling_waiting_parent_with_mutating_child_requires_review(self):
        marker = Path(self.temporary.name) / "effect.txt"
        source = Path(self.temporary.name) / "child.py"
        source.write_text("from pathlib import Path\nimport time\n"
                          "p=Path(" + repr(str(marker)) + ")\n"
                          "p.write_text((p.read_text() if p.exists() else '')+'effect\\n')\n"
                          "time.sleep(2)\nprint('{\"value\":7}')\n")
        child = self.runtime.register({
            "schema": "pkm.action.definition/v1", "action_id": "fixture.cancel.child", "version": 1,
            "input_schema": {"type": "object"}, "output_schema": {"type": "object"}, "effects": ["local-write"],
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": sys.executable,
                "args": [str(source)], "files": [str(source)]}], "examples": [{"inputs": {}}]})
        _atomic_write(self.runtime.root / "policy.json", {"schema": "pkm.action.policy/v1", "grants": [{
            "action_id": child["action_id"], "content_hash": child["content_hash"], "trusted_host_execution": True}]})
        self.ready(child)
        parent = self.ready(self.pipeline("fixture.cancel.parent", [
            {"id": "effect", "action_id": child["action_id"], "inputs": {}}],
            effects=["local-write"], dependencies={child["action_id"]: child["content_hash"]}))
        before = marker.read_text()
        run = self.call(parent)
        self.state(run["run_id"], {"waiting"})
        until = time.monotonic() + 10
        while marker.read_text() == before and time.monotonic() < until:
            time.sleep(0.02)
        self.assertEqual(marker.read_text(), before + "effect\n")
        self.api("cancel_run", run_id=run["run_id"])
        result = self.runtime.get(run["run_id"])
        self.assertEqual(result["state"], "outcome_unknown")
        self.assertEqual(result["reasonCode"], "cancelled-with-unresolved-child")
        children = [json.loads(path.read_text()) for path in (self.runtime.root / "runs").glob("*/run.json")
                    if json.loads(path.read_text()).get("parent_run_id") == run["run_id"]]
        self.assertEqual(len(children), 1)
        self.state(children[0]["run_id"], {"outcome_unknown"})
        self.assertEqual(self.api("safety_scan")["dispatched"], [])
        self.assertEqual(marker.read_text(), before + "effect\n")

    def test_lost_host_timer_and_ten_event_deliveries_do_not_duplicate_steps(self):
        definition = self.ready(self.pipeline("fixture.event", [
            {"id": "before", "component": "core.constant", "inputs": {"value": "preserved"}},
            {"id": "pause", "component": "core.wait", "inputs": {"trigger": {"kind": "event", "name": "fixture-ready"}}},
            {"id": "after", "component": "core.lookup", "inputs": {
                "dictionary": {"result": {"$step": "before.value"}}, "key": "result"}}]))
        run = self.call(definition)
        waiting = self.state(run["run_id"], {"waiting"})
        paths = list(self.runtime.path(run["run_id"]).parent.glob("steps/*.json"))
        self.assertEqual(len(paths), 1)
        before = paths[0].read_bytes()
        for _ in range(10):
            self.api("wake_run", run_id=run["run_id"], event_name="fixture-ready", event_key="delivery-once")
        result = self.state(run["run_id"], {"succeeded"})
        self.assertEqual(result["output"], {"value": "preserved"})
        self.assertEqual(paths[0].read_bytes(), before)
        self.assertEqual(sum(receipt["operation"] == "dispatched" for receipt in result["execution"]["receipts"]), 2)
        self.assertEqual(waiting["execution"]["fence"] + 2, result["execution"]["fence"])

    def test_timer_utc_missed_scan_and_per_project_fairness(self):
        definition = self.ready(self.pipeline("fixture.schedule", [
            {"id": "value", "component": "core.constant", "inputs": {"value": 7}}]))
        runs = [self.call(definition, "schedule-" + str(index), trigger={"kind": "timer", "at": time.time() - 86400},
                          project_id="project-a" if index < 2 else "project-b") for index in range(3)]
        self.assertTrue(all(run["state"] == "waiting" for run in runs))
        first = self.api("safety_scan", limit=1)
        second = self.api("safety_scan", limit=1)
        ids = first["dispatched"] + second["dispatched"]
        projects = [self.runtime.recovery.read(run_id)["project_id"] for run_id in ids]
        self.assertEqual(set(projects), {"project-a", "project-b"})
        self.api("safety_scan", limit=1)
        for run in runs:
            self.assertEqual(self.state(run["run_id"], {"succeeded"})["output"], {"value": 7})

    def test_nested_artifact_effect_before_wait_is_not_replayed(self):
        write = self.runtime.definition("core.artifact.write")
        self.assertTrue(self.runtime.validate(write["action_id"], write["content_hash"])["ok"])
        definition = self.ready(self.pipeline("fixture.artifact.review", [
            {"id": "write", "action_id": write["action_id"], "inputs": {"text": "isolated-effect"}},
            {"id": "review", "component": "core.user-action", "inputs": {
                "prompt": "Review artifact", "options": [{"label": "Accept", "value": "yes"}], "test_choice": 0}}],
            effects=["pure", "human-input", "local-read", "local-write"],
            dependencies={write["action_id"]: write["content_hash"]}))
        run = self.call(definition)
        # Parent can first wait for a child; safety scans advance that dependency to the human checkpoint.
        until = time.monotonic() + 20
        while time.monotonic() < until:
            self.api("safety_scan")
            waiting = self.runtime.get(run["run_id"])
            if waiting.get("checkpoint", {}).get("kind") == "input":
                break
            time.sleep(0.05)
        self.assertEqual(waiting["checkpoint"]["kind"], "input", waiting)
        manifests = list((self.runtime.root / "artifacts").glob("*.json"))
        # Qualification's controlled artifact is collected; actual Run owns exactly one artifact.
        owned = [json.loads(path.read_text()) for path in manifests if json.loads(path.read_text()).get("owner_root") == run["run_id"]]
        self.assertEqual(len(owned), 1)
        child_ids = [path.parent.name for path in (self.runtime.root / "runs").glob("*/run.json")
                     if json.loads(path.read_text()).get("parent_run_id") == run["run_id"]]
        self.answer(waiting["checkpoint"], {"index": 0})
        self.state(run["run_id"], {"succeeded"})
        children_after = [path.parent.name for path in (self.runtime.root / "runs").glob("*/run.json")
                          if json.loads(path.read_text()).get("parent_run_id") == run["run_id"]]
        self.assertEqual(children_after, child_ids)

    def test_deadline_review_cancel_and_no_auto_replay(self):
        for behavior, state in [("review", "outcome_unknown"), ("cancel", "cancelled")]:
            with self.subTest(behavior=behavior):
                definition = self.checkpoint_definition(behavior == "review" and "approval" or "exception",
                                                       timeout_behavior=behavior, deadline=time.time() + 5)
                run = self.call(definition, behavior)
                waiting = self.state(run["run_id"], {"waiting"})
                with patch("action_recovery.time.time", return_value=waiting["checkpoint"]["deadline"] + 1):
                    self.runtime.recovery.safety_scan()
                result = self.runtime.get(run["run_id"])
                self.assertEqual(result["state"], state)
                with self.assertRaises(ValueError):
                    self.runtime.recovery.respond_checkpoint(run["run_id"], waiting["checkpoint"]["checkpoint_id"],
                        waiting["checkpoint"]["resume_token"], waiting["checkpoint"]["proposal_digest"],
                        {"approved": True}, "late")
                self.assertEqual(self.api("safety_scan")["dispatched"], [])

    def test_mcp_tools_use_same_run_across_components_and_explicit_approval(self):
        definition = self.checkpoint_definition("decision")

        async def scenario():
            server = FastMCP("isolated-recovery-e2e")
            register_action_tools(server, self.store, ActionRuntime(self.store))
            async with Client(server) as client:
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertFalse(tools["action_checkpoint_respond"].annotations.readOnlyHint)
                self.assertTrue(tools["action_run_checkpoints"].annotations.readOnlyHint)
                launch = (await client.call_tool("action_call", {"action_id": definition["action_id"], "inputs": {},
                    "idempotency_key": "chat-tool-call", "content_hash": definition["content_hash"]})).structured_content
                self.state(launch["run_id"], {"waiting"})
                checkpoint = (await client.call_tool("action_run_checkpoints", {"run_id": launch["run_id"]})).structured_content["checkpoints"][0]
                await client.call_tool("action_checkpoint_respond", {"run_id": launch["run_id"],
                    "checkpoint_id": checkpoint["checkpoint_id"], "resume_token": checkpoint["resume_token"],
                    "proposal_digest": checkpoint["proposal_digest"], "answer": {"approved": True}, "event_key": "chat-response"})
                result = self.state(launch["run_id"], {"succeeded"})
                fetched = (await client.call_tool("action_run_get", {"run_id": launch["run_id"]})).structured_content
                self.assertEqual(fetched["output"], result["output"])

        asyncio.run(scenario())

    def test_dependency_failure_and_unrelated_rerun_never_resumes_original(self):
        definition = self.checkpoint_definition("decision")
        dependency = self.call(definition, "original-dependency")
        dependency = self.state(dependency["run_id"], {"waiting"})
        waiter_definition = self.ready(self.pipeline("fixture.dependency.waiter", [
            {"id": "done", "component": "core.constant", "inputs": {"value": "after-dependency"}}]))
        waiter = self.call(waiter_definition, "waiter", trigger={
            "kind": "dependency", "run_id": dependency["run_id"], "expected_version": dependency["execution"]["version"]})
        self.runtime.cancel(dependency["run_id"])
        scan = self.api("safety_scan")
        self.assertIn(waiter["run_id"], scan["reviewed"])
        replacement = self.call(definition, "unrelated-new-run")
        replacement = self.state(replacement["run_id"], {"waiting"})
        self.answer(replacement["checkpoint"], {"approved": True})
        self.state(replacement["run_id"], {"succeeded"})
        self.assertEqual(self.api("safety_scan")["dispatched"], [])
        self.assertEqual(self.runtime.get(waiter["run_id"])["userState"], "Reconciling")

    def test_expired_live_worker_lease_fences_effect_completion(self):
        source = Path(self.temporary.name) / "effect.py"
        source.write_text("import pathlib,time,json\npathlib.Path('effect.txt').write_text('once')\ntime.sleep(2)\nprint(json.dumps({'value':'done'}))\n")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": "fixture.orphan",
            "version": 1, "input_schema": {"type": "object"}, "output_schema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]},
            "effects": ["local-write"], "examples": [{"inputs": {}}],
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": sys.executable,
                                 "args": [str(source)], "files": [str(source)]}]})
        _atomic_write(self.runtime.root / "policy.json", {"schema": "pkm.action.policy/v1", "grants": [
            {"action_id": definition["action_id"], "content_hash": definition["content_hash"], "trusted_host_execution": True}]})
        self.ready(definition)
        run = self.call(definition)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            record = self.runtime.recovery.read(run["run_id"])
            effect = Path(record["workspace"]) / "effect.txt"
            if effect.exists():
                break
            time.sleep(0.005)
        self.assertTrue(effect.exists())
        with self.runtime.lock():
            current = self.runtime.recovery.read(run["run_id"])
            self.assertEqual(current["execution"]["phase"], "started")
            current["execution"]["lease_expires_at"] = time.time() - 1
            _atomic_write(self.runtime.path(run["run_id"]), current)
        self.api("safety_scan")
        self.assertEqual(self.runtime.get(run["run_id"])["state"], "outcome_unknown")
        time.sleep(0.3)
        result = self.runtime.get(run["run_id"])
        self.assertEqual(result["state"], "outcome_unknown")
        self.assertEqual(effect.read_text(), "once")
        self.assertEqual(self.api("safety_scan")["dispatched"], [])
        with self.assertRaises(ValueError):
            self.runtime.recovery.reconcile_run(run["run_id"], current["execution"]["version"], "manual",
                                               {"reason": "stale evidence"}, "failed")
        reconciled = self.runtime.recovery.reconcile_run(run["run_id"], result["execution"]["version"], "manual",
                                                        {"reason": "Observed one file effect; no valid output."}, "failed")
        self.assertEqual(reconciled["state"], "failed")
        self.assertTrue(reconciled["reconciliations"])

    def test_timezone_changes_do_not_shift_utc_timer_or_cancelled_wait(self):
        definition = self.ready(self.pipeline("fixture.utc", [
            {"id": "value", "component": "core.constant", "inputs": {"value": "utc"}}]))
        due = time.time() + 3600
        run = self.call(definition, trigger={"kind": "timer", "at": due})
        for zone in ["UTC", "America/Los_Angeles", "Europe/Berlin", "Asia/Shanghai"]:
            with self.subTest(zone=zone), patch.dict(os.environ, {"TZ": zone}):
                self.assertEqual(self.api("safety_scan")["dispatched"], [])
                self.assertEqual(self.runtime.get(run["run_id"])["checkpoint"]["trigger"]["at"], due)
        self.api("cancel_run", run_id=run["run_id"])
        with patch("action_recovery.time.time", return_value=due + 1):
            self.assertEqual(self.runtime.recovery.safety_scan()["dispatched"], [])
        self.assertEqual(self.runtime.get(run["run_id"])["state"], "cancelled")

    def uncertain_effect(self, identifier, reconciler):
        source = Path(self.temporary.name) / (identifier + ".py")
        source.write_text("import pathlib,json,sys\nv=json.load(sys.stdin)\npathlib.Path('effect.txt').write_text('verified-effect')\n"
                          "if v.get('fail'):raise RuntimeError('effect response lost')\nprint(json.dumps({'value':'done'}))\n")
        definition = self.runtime.register({"schema": "pkm.action.definition/v1", "action_id": identifier,
            "version": 1, "input_schema": {"type": "object", "properties": {"fail": {"type": "boolean"}}, "required": ["fail"]},
            "output_schema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]},
            "effects": ["local-write"], "examples": [{"inputs": {"fail": False}}], "reconciler": reconciler,
            "implementations": [{"kind": "program", "platforms": [platform.system()], "program": sys.executable,
                                 "args": [str(source)], "files": [str(source)]}]})
        _atomic_write(self.runtime.root / "policy.json", {"schema": "pkm.action.policy/v1", "grants": [
            {"action_id": identifier, "content_hash": definition["content_hash"], "trusted_host_execution": True}]})
        self.ready(definition)
        run = self.runtime.call(identifier, {"fail": True}, "effect:" + identifier, definition["content_hash"])
        return self.state(run["run_id"], {"outcome_unknown"})

    def test_pinned_file_reconciler_verifies_effect_without_reexecuting_program(self):
        digest = hashlib.sha256(b"verified-effect").hexdigest()
        run = self.uncertain_effect("fixture.file.reconcile", {
            "kind": "file-hash", "path": "effect.txt", "sha256": digest, "output": {"value": "done"}})
        effect = Path(run["workspace"]) / "effect.txt"
        original = effect.stat().st_mtime_ns
        result = self.api("reconcile_run", run_id=run["run_id"], expected_version=run["execution"]["version"], kind="file-hash")
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["output"], {"value": "done"})
        self.assertEqual(effect.stat().st_mtime_ns, original)
        self.assertEqual(self.api("safety_scan")["dispatched"], [])

    def test_remote_lookup_is_pinned_read_only_and_not_a_write_retry(self):
        lookup = self.ready(self.pipeline("fixture.remote.lookup", [
            {"id": "value", "component": "core.constant", "inputs": {"value": "delivered"}}], effects=["pure"]))
        for kind in ["remote-resource", "message-order"]:
            with self.subTest(kind=kind):
                run = self.uncertain_effect("fixture.remote." + kind.replace("-", ""), {
                    "kind": kind, "lookup_action_id": lookup["action_id"], "lookup_revision": lookup["content_hash"],
                    "inputs": {}, "success_field": "value", "success_value": "delivered", "output": {"value": "done"}})
                result = self.api("reconcile_run", run_id=run["run_id"], expected_version=run["execution"]["version"], kind=kind)
                self.assertEqual(result["state"], "succeeded")
                query_id = result["reconciliations"][-1]["evidence"]["lookup_run_id"]
                self.assertNotEqual(query_id, run["run_id"])
                self.assertEqual(self.runtime.get(query_id)["execution"]["contract"]["effects"], ["read"])
                self.assertEqual(self.runtime.get(run["run_id"])["inputs"], {"fail": True})


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--serve":
        store = Path(sys.argv[2])
        runtime = ModuleRuntime(store)
        runtime.configure_workspace(str(store.parent))
        definition = runtime.register({"schema": "pkm.action.definition/v1", "action_id": "fixture.chat.review",
            "version": 1, "input_schema": {"type": "object"}, "output_schema": {"type": "object"},
            "effects": ["human-input"], "examples": [{"inputs": {}}],
            "implementations": [{"kind": "pipeline", "platforms": [platform.system()], "steps": [{
                "id": "review", "component": "core.checkpoint", "inputs": {
                    "kind": "approval", "proposal": {"change": "Approve isolated Chat fixture", "revision": 1},
                    "answer_schema": {"type": "object", "properties": {"approved": {"type": "boolean"}}, "required": ["approved"]},
                    "test_answer": {"approved": True}}}], "output": {"value": {"$step": "review.value"}}}]})
        result = runtime.validate(definition["action_id"], definition["content_hash"])
        if not result["ok"]:
            raise RuntimeError("Chat E2E fixture qualification failed.")
        _atomic_write(store.parent / "fixture.json", definition)
        server = FastMCP("pkm-chat-action-e2e")
        register_action_tools(server, store, ActionRuntime(store))
        server.run(transport="http", host="127.0.0.1", port=int(sys.argv[3]), show_banner=False)
    else:
        unittest.main()
