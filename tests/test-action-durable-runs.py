import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from action_run_store import ActionRunStore, action_contract
from action_modules import ModuleRuntime, digest
from recipe_runtime import _atomic_write


class DurableRunTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "store" / ".pkm" / "state" / "actions"
        self.runs = ActionRunStore(self.root)
        self.run_id = "action_run_" + "1" * 32
        self.key = self.root / "module-keys" / ("2" * 64 + ".json")
        self.definition = {"action_id": "fixture.effect", "content_hash": "3" * 64,
                           "effects": ["remote-write"], "input_schema": {"type": "object"},
                           "output_schema": {"type": "object"}}
        self.record = {"run_id": self.run_id, "state": "running", "engine": "module",
                       "action_id": "fixture.effect", "definition": self.definition,
                       "capability_hash": digest("secret"), "workspace": self.temporary.name,
                       "environment_fingerprint": "4" * 64}

    def prepare(self):
        return self.runs.prepare(copy.deepcopy(self.record), self.key, "5" * 64, self.definition)

    def test_each_partial_launch_recovers_one_original_run_and_receipt(self):
        for failure_write in (2, 3):
            with self.subTest(failure_write=failure_write), tempfile.TemporaryDirectory() as directory:
                runs = ActionRunStore(Path(directory))
                key = Path(directory) / "module-keys" / self.key.name
                count = 0

                def interrupted(path, value):
                    nonlocal count
                    count += 1
                    if count == failure_write:
                        raise OSError("injected process loss")
                    _atomic_write(path, value)

                with patch("action_run_store._atomic_write", interrupted), self.assertRaises(OSError):
                    runs.prepare(copy.deepcopy(self.record), key, "5" * 64, self.definition)
                runs.recover_launches()
                runs.recover_launches()
                self.assertEqual(json.loads(key.read_text())["run_id"], self.run_id)
                self.assertEqual(json.loads(runs.path(self.run_id).read_text())["execution"]["phase"], "created")
                self.assertEqual(len(list((Path(directory) / "runs").glob("*/run.json"))), 1)
                self.assertEqual(list((Path(directory) / "launch-journal").glob("*.json")), [])

    def test_journal_refuses_conflicting_receipt(self):
        with patch("action_run_store._atomic_write", side_effect=[None, OSError("crash")]):
            with self.assertRaises(OSError):
                self.prepare()
        self.prepare()
        journal = self.root / "launch-journal" / (self.run_id + ".json")
        _atomic_write(journal, {"record": json.loads(self.runs.path(self.run_id).read_text()),
                               "key_path": str(self.key),
                               "receipt": {"run_id": self.run_id, "fingerprint": "5" * 64}})
        _atomic_write(self.key, {"run_id": self.run_id, "fingerprint": "6" * 64})
        with self.assertRaisesRegex(ValueError, "conflicts"):
            self.runs.recover_launches()

    def test_duplicate_worker_and_stale_completion_are_fenced(self):
        self.prepare()
        record = self.runs.claim(self.run_id)
        with self.assertRaises(PermissionError):
            self.runs.claim(self.run_id)
        recovered = copy.deepcopy(record)
        recovered["state"] = "outcome_unknown"
        self.runs.transition(recovered, "reconciling", "worker-unavailable", "user")
        record["state"] = "succeeded"
        with self.assertRaises(PermissionError):
            self.runs.finish(record)
        self.assertEqual(json.loads(self.runs.path(self.run_id).read_text())["state"], "outcome_unknown")

    def test_choice_checkpoint_and_completion_preserve_receipts(self):
        self.prepare()
        record = self.runs.claim(self.run_id)
        self.runs.checkpoint(record, "waiting", "user-choice", "user")
        self.assertEqual(self.runs.public(record)["userState"], "Waiting")
        self.assertEqual(self.runs.public(record)["nextOwner"], "user")
        self.runs.checkpoint(record, "started", "choice-answered")
        record["state"] = "succeeded"
        self.runs.finish(record)
        operations = [receipt["operation"] for receipt in record["execution"]["receipts"]]
        self.assertEqual(operations, ["created", "started", "waiting", "started", "completed"])

    def test_effect_exception_preserves_evidence_and_never_reports_failed(self):
        runtime = ModuleRuntime(Path(self.temporary.name) / "store")
        record = self.prepare()
        effect = Path(self.temporary.name) / "effect-receipt"

        def write_then_crash(*args):
            effect.write_text("effect may have completed")
            raise RuntimeError("response persistence lost")

        with patch.dict(os.environ, {"PKM_ACTION_TOKEN": "secret"}), patch.object(runtime, "execute", write_then_crash), patch.object(runtime, "gc") as gc:
            runtime.worker(self.run_id)
            gc.assert_not_called()
        result = runtime.get(self.run_id)
        self.assertEqual(result["state"], "outcome_unknown")
        self.assertEqual(result["userState"], "Reconciling")
        self.assertTrue(effect.exists())
        self.assertEqual(result["execution"]["contract"], record["execution"]["contract"])

    def test_invalid_worker_token_does_not_consume_dispatch(self):
        runtime = ModuleRuntime(Path(self.temporary.name) / "store")
        self.prepare()
        with patch.dict(os.environ, {"PKM_ACTION_TOKEN": "wrong"}), self.assertRaises(PermissionError):
            runtime.worker(self.run_id)
        self.assertEqual(json.loads(self.runs.path(self.run_id).read_text())["execution"]["phase"], "created")

    def test_recovery_before_dispatch_never_replays_effects(self):
        runtime = ModuleRuntime(Path(self.temporary.name) / "store")
        self.prepare()
        with patch("action_modules.subprocess.Popen") as spawn:
            result = runtime.recover()
            spawn.assert_not_called()
        self.assertEqual(result["reconciled"], [self.run_id])
        self.assertEqual(runtime.get(self.run_id)["state"], "outcome_unknown")
        self.assertEqual(json.loads(self.key.read_text())["run_id"], self.run_id)

    def test_contract_missing_metadata_is_high_risk_and_not_retryable(self):
        contract = action_contract({"action_id": "legacy", "content_hash": "hash"})
        self.assertEqual(contract["effects"], ["unknown"])
        self.assertFalse(contract["retryPolicy"]["automatic"])
        self.assertFalse(contract["idempotency"]["externalEffectGuaranteed"])
        self.prepare()
        self.definition["effects"] = ["pure"]
        saved = json.loads(self.runs.path(self.run_id).read_text())
        self.assertEqual(saved["execution"]["contract"]["effects"], ["write"])
        self.assertEqual(saved["execution"]["environment"]["configurationDigest"], "4" * 64)

    def test_parallel_duplicate_submission_after_host_crash_executes_once(self):
        store = Path(self.temporary.name) / "store"
        runtime = ModuleRuntime(store)
        runtime.configure_workspace(self.temporary.name)
        constant = next(item for item in runtime.components() if item["action_id"] == "core.constant")
        definition = runtime.graph_save({"action_id": "fixture.concurrent", "nodes": [
            {"id": "one", "action_id": "core.constant", "value_type": "integer",
             "content_hash": constant["content_hash"], "parameters": {"value": 3}}],
            "edges": [], "output_node": "one"})
        self.assertTrue(runtime.validate(definition["action_id"], definition["content_hash"])["ok"])
        crashed = subprocess.run([sys.executable, "-c",
            "import os,sys;from action_modules import ModuleRuntime\n"
            "with ModuleRuntime(sys.argv[1]).lock():os._exit(7)", str(store)],
            cwd=Path(__file__).resolve().parents[1] / "resources", timeout=10)
        self.assertEqual(crashed.returncode, 7)
        payload = {"method": "call", "params": {"action_id": definition["action_id"],
                   "inputs": {}, "key": "same-submission", "content_hash": definition["content_hash"]}}

        def submit(_):
            process = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "resources" / "action_modules.py"),
                                      "--api", str(store)], input=json.dumps(payload),
                                     text=True, capture_output=True, timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr)
            return json.loads(process.stdout)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = pool.map(submit, range(2))
        self.assertEqual(first["run_id"], second["run_id"])
        self.assertEqual(sorted([first["launch_reused"], second["launch_reused"]]), [False, True])
        result = runtime.wait(first["run_id"])
        self.assertEqual(result["output"], {"value": 3})
        self.assertEqual(result["execution"]["fence"], 1)

    def test_platform_response_before_completion_is_not_false_success(self):
        from action_runtime import ActionRuntime
        record = copy.deepcopy(self.record)
        record["engine"] = "platform"
        self.runs.prepare(record, self.key, "5" * 64, self.definition)
        self.runs.claim(self.run_id)
        path = self.runs.path(self.run_id)
        current = json.loads(path.read_text())
        current["execution"]["workerPid"] = 2147483647
        _atomic_write(path, current)
        _atomic_write(path.with_name("result.json"), {"ok": True, "stdout": '{"remote":"accepted"}'})
        runtime = ActionRuntime(Path(self.temporary.name) / "store")
        self.assertEqual(runtime.recover()["reconciled"], [self.run_id])
        self.assertEqual(runtime.get(self.run_id)["userState"], "Reconciling")
        self.assertTrue(path.with_name("result.json").exists())

    def test_explicit_recovery_clears_incomplete_crashed_lock(self):
        runtime = ModuleRuntime(Path(self.temporary.name) / "store")
        self.prepare()
        (runtime.root / "mutation.lock").write_text("")
        self.assertEqual(runtime.recover()["reconciled"], [self.run_id])
        self.assertFalse((runtime.root / "mutation.lock").exists())


if __name__ == "__main__":
    unittest.main()
