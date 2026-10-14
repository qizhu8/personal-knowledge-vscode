"""Durable launch receipts and fenced lifecycle for existing Action Runs."""

import json
import os
import platform
import re
import time
from pathlib import Path

from recipe_runtime import _atomic_write


def action_contract(definition):
    """Adapt legacy metadata conservatively without granting new permissions."""
    effects = definition.get("effects", [definition.get("effect", "unknown")])
    levels = {"pure": "read", "read": "read", "local-read": "read", "remote-read": "read",
              "human-input": "read", "local-write": "write", "remote-write": "write",
              "send": "send", "delete": "delete", "spend": "spend"}
    normalized = sorted({levels.get(effect, "unknown") for effect in effects})
    return {"schema": "pkm.action.execution-contract/v1", "actionId": definition["action_id"],
            "revision": definition["content_hash"], "effects": normalized,
            "inputSchema": definition.get("input_schema"), "outputSchema": definition.get("output_schema"),
            "requiredCapabilities": sorted(set(effects)),
            "resourceClaims": [{"resource": "invocation-workspace", "access": "read" if normalized == ["read"] else "write"}],
            "timeoutPolicy": {"kind": "deadline", "onTimeout": "reconcile"},
            "retryPolicy": {"automatic": False, "reason": "Reconcile the original Run before any new attempt."},
            "idempotency": {"kind": "launch-key", "externalEffectGuaranteed": False},
            "receiptContract": "pkm.action.execution/v1"}


class ActionRunStore:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, run_id):
        if not isinstance(run_id, str) or not re.fullmatch(r"action_run_[0-9a-f]{32}", run_id):
            raise ValueError("Invalid durable Action Run identity.")
        return self.root / "runs" / run_id / "run.json"

    def _key(self, value):
        key = Path(value)
        if key.parent not in {self.root / "keys", self.root / "module-keys"} or not re.fullmatch(r"[0-9a-f]{64}\.json", key.name):
            raise ValueError("Invalid Action launch receipt path.")
        return key

    def recover_launches(self):
        """Caller holds the existing Action mutation lock."""
        for journal in sorted((self.root / "launch-journal").glob("*.json")):
            value = json.loads(journal.read_text(encoding="utf-8"))
            record, receipt = value["record"], value["receipt"]
            run_path = self.path(record["run_id"])
            if receipt["run_id"] != record["run_id"] or record.get("execution", {}).get("invocationFingerprint") != receipt["fingerprint"]:
                raise ValueError("Action launch journal identity is invalid.")
            key_path = self._key(value["key_path"])
            if key_path.exists() and json.loads(key_path.read_text(encoding="utf-8")) != receipt:
                raise ValueError("Action launch journal conflicts with an existing receipt.")
            if not run_path.exists():
                _atomic_write(run_path, record)
            else:
                existing = json.loads(run_path.read_text(encoding="utf-8"))
                if existing.get("run_id") != record["run_id"] or existing.get("execution", {}).get("invocationFingerprint") != receipt["fingerprint"]:
                    raise ValueError("Action launch journal conflicts with an existing Run.")
            if not key_path.exists():
                _atomic_write(key_path, receipt)
            journal.unlink()

    def prepare(self, record, key_path, fingerprint, definition):
        """Commit run and invocation receipt before dispatch; recover partial commit."""
        contract = action_contract(definition)
        record["execution"] = {
            "schema": "pkm.action.execution/v1", "version": 1, "fence": 0, "phase": "created",
            "invocationFingerprint": fingerprint, "definitionRevision": definition["content_hash"],
            "environment": {"platform": platform.system(), "workingDirectory": record.get("workspace"),
                            "configurationDigest": record.get("environment_fingerprint")},
            "contract": contract, "launchFingerprint": fingerprint, "owner": "execution-host",
            "reasonCode": "dispatch-pending", "resumeCondition": "Dispatch this committed Run.",
            "receipts": [{"operation": "created", "at": time.time(), "version": 1}],
        }
        receipt = {"run_id": record["run_id"], "fingerprint": fingerprint}
        journal = self.root / "launch-journal" / (record["run_id"] + ".json")
        _atomic_write(journal, {"record": record, "key_path": str(self._key(key_path)), "receipt": receipt})
        _atomic_write(self.path(record["run_id"]), record)
        _atomic_write(key_path, receipt)
        journal.unlink()
        return record

    def transition(self, record, phase, reason, owner="execution-host"):
        execution = record.get("execution")
        if not execution:
            return record
        execution.update({"phase": phase, "version": execution["version"] + 1,
                          "owner": owner, "reasonCode": reason,
                          "resumeCondition": "Inspect receipts and reconcile effects; do not resubmit." if phase == "reconciling" else
                          "Answer the pending choice in this Run." if phase == "waiting" else
                          "Wait for the execution host checkpoint." if phase in {"started", "dispatched"} else None})
        execution["receipts"].append({"operation": phase, "at": time.time(), "version": execution["version"]})
        _atomic_write(self.path(record["run_id"]), record)
        return record

    def claim(self, run_id):
        record = json.loads(self.path(run_id).read_text(encoding="utf-8"))
        execution = record.get("execution")
        if not execution or execution["phase"] not in {"created", "dispatched"} or record["state"] != "running":
            raise PermissionError("Action worker dispatch is stale or already claimed.")
        execution.update({"fence": execution["fence"] + 1, "workerPid": os.getpid()})
        return self.transition(record, "started", "executing")

    def finish(self, record):
        current = json.loads(self.path(record["run_id"]).read_text(encoding="utf-8"))
        execution = record.get("execution")
        if execution:
            saved = current.get("execution", {})
            if saved.get("fence") != execution["fence"] or saved.get("workerPid") != os.getpid() or saved.get("phase") not in {"started", "waiting"}:
                raise PermissionError("Action completion is fenced by newer recovery or execution state.")
            record["execution"] = saved
        phase = "reconciling" if record["state"] == "outcome_unknown" else "completed"
        return self.transition(record, phase, record["state"], "user" if phase == "reconciling" else "none") if execution else self._legacy_finish(record)

    def checkpoint(self, record, phase, reason, owner="execution-host"):
        current = json.loads(self.path(record["run_id"]).read_text(encoding="utf-8"))
        saved = current["execution"]
        if saved["fence"] != record["execution"]["fence"] or saved.get("workerPid") != os.getpid() or saved["phase"] not in {"started", "waiting"}:
            raise PermissionError("Action checkpoint is fenced by recovery.")
        record["execution"] = saved
        self.transition(record, phase, reason, owner)

    def _legacy_finish(self, record):
        _atomic_write(self.path(record["run_id"]), record)
        return record

    def public(self, record):
        execution = record.get("execution", {})
        state = record.get("state")
        uncertain = state == "outcome_unknown"
        waiting = state == "running" and execution.get("phase") == "waiting"
        return {**record, "productObject": "Run", "userState": "Reconciling" if uncertain else "Waiting" if waiting else
                {"running": "Running", "succeeded": "Completed", "failed": "Failed", "cancelled": "Cancelled"}.get(state, "Blocked"),
                "nextOwner": "user" if uncertain or waiting else "execution-host" if state == "running" else "none",
                "reasonCode": execution.get("reasonCode", "legacy-run"),
                "lastCheckpoint": execution.get("receipts", [])[-1:] or None}
