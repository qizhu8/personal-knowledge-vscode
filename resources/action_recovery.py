"""Checkpoint, wakeup and reconciliation operations on the existing Action Run store."""

import hashlib
import datetime
import contextlib
import json
import math
import os
import secrets
import subprocess
import sys
import time
import threading
import uuid
from pathlib import Path

from jsonschema import Draft202012Validator
from recipe_runtime import _atomic_write, _background_process_options


def process_alive(pid):
    from action_modules import process_alive as alive
    return alive(pid)


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class ActionSuspended(Exception):
    """The worker has committed a durable continuation and must release execution."""


RECONCILER_REGISTRY = {
    "manual": "explicit-user-evidence",
    "file-hash": "workspace-sha256",
    "process-status": "read-only-process-inspection",
    "remote-resource": "pinned-read-only-action",
    "message-order": "pinned-read-only-action",
}


def validate_reconciler(value):
    if not isinstance(value, dict) or value.get("kind") not in RECONCILER_REGISTRY:
        raise ValueError("Reconciler must declare a supported registry kind.")
    if value["kind"] == "file-hash":
        path = Path(value.get("path", ""))
        digest = value.get("sha256")
        if (not str(value.get("path", "")) or path.is_absolute() or ".." in path.parts
                or not isinstance(digest, str) or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest) or "output" not in value):
            raise ValueError("File reconciler requires a relative workspace path, pinned SHA-256 and typed output.")
    elif value["kind"] in {"remote-resource", "message-order"}:
        if (not isinstance(value.get("lookup_action_id"), str) or not isinstance(value.get("lookup_revision"), str)
                or not isinstance(value.get("inputs"), dict) or not isinstance(value.get("success_field"), str)
                or "success_value" not in value or "output" not in value):
            raise ValueError("Remote reconciler requires a pinned read-only lookup Action and exact success predicate/output.")
    return value

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class ActionRecovery:
    def __init__(self, runtime):
        self.runtime = runtime

    def read(self, run_id):
        return json.loads(self.runtime.path(run_id).read_text(encoding="utf-8"))

    def _authoritative(self, record):
        current = self.read(record["run_id"])
        execution = current["execution"]
        if (execution["fence"] != record["execution"]["fence"] or execution.get("workerPid") != os.getpid()
                or execution["phase"] != "started" or current["state"] != "running"):
            raise PermissionError("Continuation is fenced by newer Run authority.")
        return current

    @contextlib.contextmanager
    def lease(self, record):
        stopped, failures = threading.Event(), []

        def heartbeat():
            while not stopped.wait(5):
                try:
                    with self.runtime.lock():
                        current = self._authoritative(record)
                        current["execution"].update({"heartbeat_at": time.time(), "lease_expires_at": time.time() + 20})
                        _atomic_write(self.runtime.path(record["run_id"]), current)
                except (OSError, ValueError, PermissionError, RuntimeError) as error:
                    failures.append(error)
                    stopped.set()

        thread = threading.Thread(target=heartbeat, name="action-lease", daemon=True)
        thread.start()
        try:
            yield
            if failures:
                raise RuntimeError("Action heartbeat could not renew its execution lease.") from failures[0]
        finally:
            stopped.set()
            thread.join(timeout=6)
            if thread.is_alive():
                raise RuntimeError("Action heartbeat did not release its lease.")

    def step_path(self, record, key):
        return self.runtime.path(record["run_id"]).parent / "steps" / (fingerprint(key) + ".json")

    def step_event(self, record, key, definition, state, reason=None):
        if state not in {"running", "completed", "failed", "ignored", "waiting"}:
            raise ValueError("Invalid Component observation state.")
        with self.runtime.lock():
            self._authoritative(record)
            path = self.runtime.path(record["run_id"]).parent / "step-events" / (fingerprint(key) + ".json")
            value = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
                "schema": "pkm.action.component-events/v1", "key": key,
                "definition_digest": fingerprint(definition), "component": definition.get("component"),
                "action_id": definition.get("action_id"), "implementation_kind": definition.get("kind"),
                "program": definition.get("program"), "tool": definition.get("tool"), "events": []}
            if value["key"] != key or value["definition_digest"] != fingerprint(definition):
                raise ValueError("Component observation does not match its pinned definition.")
            value["state"] = state
            value["events"].append({"state": state, "at": time.time(),
                                    "fence": record["execution"]["fence"], "reason": reason})
            _atomic_write(path, value)

    def step_result(self, record, key, definition):
        path = self.step_path(record, key)
        if not path.exists():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        if value["key"] != key or value["definition_digest"] != fingerprint(definition):
            raise ValueError("Durable step receipt does not match the pinned continuation.")
        if value["state"] != "completed":
            raise RuntimeError("Step effect has no completion receipt; reconcile instead of replaying.")
        return value

    def step_commit(self, record, key, definition, output, scope_outputs=None):
        with self.runtime.lock():
            self._authoritative(record)
            _atomic_write(self.step_path(record, key), {
                "schema": "pkm.action.step-receipt/v1", "key": key, "state": "completed",
                "definition_digest": fingerprint(definition), "output": output, "scope_outputs": scope_outputs or {},
                "fence": record["execution"]["fence"], "at": time.time()})
        self.step_event(record, key, definition, "completed")

    def suspend(self, record, key, kind, proposal, evidence=None, owner="user", deadline=None,
                timeout_behavior="review", trigger=None, answer_schema=None, presentation="json"):
        if kind not in {"input", "approval", "artifact-review", "decision", "exception"}:
            raise ValueError("Unsupported checkpoint kind.")
        if timeout_behavior not in {"review", "cancel"} or not isinstance(owner, str) or not owner.strip():
            raise ValueError("Checkpoint requires an owner and an explicit timeout behavior.")
        if presentation not in {"json", "choice"}:
            raise ValueError("Checkpoint presentation must be JSON or an explicit user choice.")
        if deadline is not None and (type(deadline) not in {int, float} or not math.isfinite(deadline)):
            raise ValueError("Checkpoint deadline must be an absolute UTC epoch timestamp.")
        if len(json.dumps({"proposal": proposal, "evidence": evidence}, allow_nan=False).encode()) > 65536:
            raise ValueError("Checkpoint proposal and evidence exceed 64 KiB.")
        schema = answer_schema or {"type": "object"}
        Draft202012Validator.check_schema(schema)
        with self.runtime.lock():
            self._authoritative(record)
            previous = record.get("checkpoint")
            if previous:
                _atomic_write(self.runtime.path(record["run_id"]).parent / "checkpoints" /
                              (previous["checkpoint_id"] + ".json"), previous)
            checkpoint = {
                "schema": "pkm.action.checkpoint/v1", "checkpoint_id": "checkpoint_" + uuid.uuid4().hex,
                "run_id": record["run_id"], "step": key, "kind": kind, "state": "waiting",
                "proposal": proposal, "proposal_digest": fingerprint(proposal), "evidence": evidence or [],
                "owner": owner, "created_at": time.time(), "deadline": deadline,
                "timeout_behavior": timeout_behavior, "resume_token": secrets.token_hex(24),
                "answer_schema": schema, "trigger": trigger or {"kind": "human"},
                "presentation": presentation,
                "remaining_seconds": max(0.0, record["deadline"] - time.time()),
            }
            event_directory = self.runtime.path(record["run_id"]).parent / "step-events"
            for component_path in event_directory.glob("*.json"):
                component = json.loads(component_path.read_text(encoding="utf-8"))
                if component.get("state") != "running" or not (
                        component["key"] == "__implementation__" or component["key"] == key
                        or key.startswith(component["key"] + "/")):
                    continue
                component["state"] = "waiting"
                component["events"].append({"state": "waiting", "at": time.time(),
                                            "fence": record["execution"]["fence"], "reason": "checkpoint-" + kind})
                _atomic_write(component_path, component)
            record.update({"state": "waiting", "checkpoint": checkpoint, "current_step": key})
            record["execution"].update({"fence": record["execution"]["fence"] + 1, "workerPid": None})
            self.runtime.runs.transition(record, "waiting", "checkpoint-" + kind, owner)
        raise ActionSuspended(record["run_id"])

    def resolved(self, record, key):
        checkpoint = record.get("checkpoint")
        if checkpoint and checkpoint["step"] == key and checkpoint["state"] == "resolved":
            return checkpoint
        return None

    def validate_trigger(self, trigger):
        if not isinstance(trigger, dict) or trigger.get("kind") not in {"timer", "event", "dependency"}:
            raise ValueError("Declare a timer, event or dependency trigger.")
        normalized = dict(trigger)
        allowed = {"timer": {"kind", "at"}, "event": {"kind", "name"},
                   "dependency": {"kind", "run_id", "expected_version", "invocation_fingerprint"}}[trigger["kind"]]
        if set(trigger) - allowed:
            raise ValueError("Trigger contains unsupported fields.")
        if trigger["kind"] == "timer":
            at = trigger.get("at")
            if type(at) not in {int, float} or not math.isfinite(at) or at < 0:
                raise ValueError("Timer requires an absolute UTC epoch timestamp.")
        elif trigger["kind"] == "event":
            if not isinstance(trigger.get("name"), str) or not 1 <= len(trigger["name"]) <= 200:
                raise ValueError("Event trigger requires a bounded event name.")
        else:
            self.runtime.path(trigger.get("run_id"))
            if type(trigger.get("expected_version")) is not int or trigger["expected_version"] < 1:
                raise ValueError("Dependency must pin the existing Run execution version.")
            dependency = self.read(trigger["run_id"])
            if dependency.get("execution", {}).get("version", 0) < trigger["expected_version"]:
                raise ValueError("Dependency revision is unavailable; inspect the original Run before scheduling.")
            if ("invocation_fingerprint" in trigger and trigger["invocation_fingerprint"] !=
                    dependency.get("execution", {}).get("invocationFingerprint")):
                raise ValueError("Dependency invocation identity changed.")
            normalized["invocation_fingerprint"] = dependency.get("execution", {}).get("invocationFingerprint")
        return normalized

    def prepare_schedule(self, record, trigger, key):
        record.update({"state": "waiting", "schedule_key": key, "checkpoint": {
            "schema": "pkm.action.checkpoint/v1", "checkpoint_id": "checkpoint_" + uuid.uuid4().hex,
            "run_id": record["run_id"], "step": "__dispatch__", "kind": "decision", "state": "waiting",
            "proposal": {"action_id": record["action_id"], "revision": record["content_hash"]},
            "evidence": [], "owner": "scheduler", "created_at": time.time(), "deadline": None,
            "timeout_behavior": "review", "resume_token": secrets.token_hex(24),
            "answer_schema": {"type": "object"}, "trigger": trigger, "remaining_seconds": 300}})
        record["checkpoint"]["proposal_digest"] = fingerprint(record["checkpoint"]["proposal"])
        self.runtime.runs.transition(record, "waiting", "scheduled-" + trigger["kind"], "scheduler")

    def checkpoints(self, run_id, include_history=False):
        if type(include_history) is not bool:
            raise ValueError("Checkpoint history selection must be boolean.")
        record = self.read(run_id)
        root = record.get("root_run_id", run_id)
        requests = []
        for path in (self.runtime.root / "runs").glob("*/run.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("root_run_id", value["run_id"]) == root:
                if include_history:
                    requests.extend(json.loads(item.read_text(encoding="utf-8"))
                                    for item in sorted((path.parent / "checkpoints").glob("*.json")))
                if value.get("checkpoint"):
                    requests.append(value["checkpoint"])
        return {"ok": True, "checkpoints": requests}

    def _resolve(self, record, checkpoint, answer, event_key):
        if record["state"] != "waiting" or checkpoint["state"] != "waiting":
            raise ValueError("Checkpoint is no longer waiting.")
        checkpoint.update({"state": "resolved", "answer": answer, "resolved_at": time.time(),
                           "answer_digest": fingerprint(answer), "event_key": event_key})
        record["execution"].update({"fence": record["execution"]["fence"] + 1, "workerPid": None})
        self.runtime.runs.transition(record, "ready", "checkpoint-resolved", "execution-host")

    def check_checkpoint_answer(self, run_id, checkpoint_id, answer):
        with self.runtime.lock():
            record = self.read(run_id)
            checkpoint = record.get("checkpoint")
            if (record["state"] != "waiting" or not checkpoint or checkpoint["checkpoint_id"] != checkpoint_id
                    or checkpoint["state"] != "waiting" or checkpoint["trigger"]["kind"] != "human"):
                raise ValueError("This human checkpoint is no longer waiting.")
            if checkpoint.get("deadline") is not None and time.time() >= checkpoint["deadline"]:
                raise ValueError("Checkpoint deadline expired.")
            Draft202012Validator(checkpoint["answer_schema"]).validate(answer)
        return {"ok": True}

    def respond_checkpoint(self, run_id, checkpoint_id, resume_token, proposal_digest, answer, event_key):
        if not isinstance(event_key, str) or not 1 <= len(event_key) <= 200:
            raise ValueError("Checkpoint response needs a stable event key.")
        with self.runtime.lock():
            record = self.read(run_id)
            checkpoint = record.get("checkpoint")
            if not checkpoint or checkpoint["checkpoint_id"] != checkpoint_id:
                raise ValueError("Checkpoint identity is stale.")
            if (checkpoint["resume_token"] != resume_token or checkpoint["proposal_digest"] != proposal_digest
                    or fingerprint(checkpoint["proposal"]) != proposal_digest):
                raise PermissionError("Response must bind the exact proposal and resume token.")
            if checkpoint["state"] == "resolved":
                if checkpoint["answer_digest"] != fingerprint(answer):
                    raise ValueError("Checkpoint has already been answered differently.")
                return {"ok": True, "run_id": run_id, "replayed": True}
            if checkpoint["trigger"]["kind"] != "human":
                raise PermissionError("This checkpoint is owned by its durable trigger.")
            if checkpoint.get("deadline") is not None and time.time() >= checkpoint["deadline"]:
                raise ValueError("Checkpoint deadline expired; run the safety scan.")
            Draft202012Validator(checkpoint["answer_schema"]).validate(answer)
            self._resolve(record, checkpoint, answer, event_key)
        self.safety_scan()
        return {"ok": True, "run_id": run_id, "replayed": False}

    def schedule_run(self, run_id, trigger, event_key, owner="scheduler", deadline=None, timeout_behavior="review"):
        if not isinstance(event_key, str) or not 1 <= len(event_key) <= 200:
            raise ValueError("Schedule requires a stable event key.")
        normalized = self.validate_trigger(trigger)
        if timeout_behavior not in {"review", "cancel"} or not isinstance(owner, str) or not owner.strip():
            raise ValueError("Invalid schedule owner or timeout behavior.")
        if deadline is not None and (type(deadline) not in {int, float} or not math.isfinite(deadline)):
            raise ValueError("Schedule deadline must be an absolute UTC timestamp.")
        with self.runtime.lock():
            record = self.read(run_id)
            if record.get("schedule_key") == event_key:
                if record.get("schedule_config") != fingerprint([normalized, owner, deadline, timeout_behavior]):
                    raise ValueError("Schedule key was reused for a different trigger.")
                return self.runtime.runs.public(record)
            if (record.get("engine") != "module" or record["state"] != "waiting" or
                    record.get("checkpoint", {}).get("step") != "__dispatch__" or record["checkpoint"]["state"] != "waiting"):
                raise ValueError("Only an explicitly prepared continuation can be scheduled.")
            record["schedule_key"] = event_key
            record["schedule_config"] = fingerprint([normalized, owner, deadline, timeout_behavior])
            record["checkpoint"].update({"state": "waiting", "trigger": normalized, "owner": owner,
                                         "deadline": deadline, "timeout_behavior": timeout_behavior,
                                         "resume_token": secrets.token_hex(24)})
            self.runtime.runs.transition(record, "waiting", "scheduled-" + trigger["kind"], owner)
        return self.runtime.runs.public(record)

    def wake_run(self, run_id, event_key, event_name):
        if not isinstance(event_key, str) or not 1 <= len(event_key) <= 200:
            raise ValueError("Wakeup requires a stable event identity.")
        with self.runtime.lock():
            record = self.read(run_id)
            checkpoint = record.get("checkpoint", {})
            trigger = checkpoint.get("trigger", {})
            if trigger.get("kind") != "event" or trigger.get("name") != event_name:
                raise ValueError("Wakeup does not match the current event trigger.")
            if checkpoint["state"] == "resolved":
                if checkpoint.get("event_key") != event_key:
                    raise ValueError("Another event already resolved this checkpoint.")
                return {"ok": True, "run_id": run_id, "replayed": True}
            if checkpoint.get("deadline") is not None and time.time() >= checkpoint["deadline"]:
                raise ValueError("Event arrived after the checkpoint deadline; inspect the safety scan outcome.")
            self._resolve(record, checkpoint, {"event": event_name}, event_key)
        self.safety_scan()
        return {"ok": True, "run_id": run_id, "replayed": False}

    def associate_project(self, run_id, project_id):
        if not isinstance(project_id, str) or not 1 <= len(project_id) <= 200 or any(ord(char) < 32 for char in project_id):
            raise ValueError("A bounded Project identity is required.")
        with self.runtime.lock():
            record = self.read(run_id)
            record["project_id"] = project_id
            _atomic_write(self.runtime.path(run_id), record)
        return {"ok": True, "run_id": run_id, "project_id": project_id}

    def _review(self, record, reason):
        record.update({"state": "outcome_unknown", "ok": False, "error": reason})
        record["execution"].update({"fence": record["execution"]["fence"] + 1, "workerPid": None})
        self.runtime.runs.transition(record, "reconciling", reason, "user")

    def _dispatch(self, record):
        parent_id = record.get("parent_run_id")
        if parent_id and self.read(parent_id)["state"] not in {"running", "waiting"}:
            self._review(record, "parent-requires-review")
            return False
        token = secrets.token_hex(32)
        record["capability_hash"] = fingerprint(token)
        # ModuleRuntime.digest encodes strings with the same canonical JSON representation.
        record["state"] = "running"
        checkpoint = record["checkpoint"]
        record["deadline"] = time.time() + checkpoint.get("remaining_seconds", 300)
        checkpoint["dispatch_at"] = time.time()
        record["execution"].update({"heartbeat_at": time.time(), "lease_expires_at": time.time() + 20})
        self.runtime.runs.transition(record, "dispatched", "wakeup-dispatch")
        try:
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("action_modules.py")),
                                        "--worker", str(self.runtime.store), record["run_id"]],
                                       env={**os.environ, "PKM_ACTION_TOKEN": token}, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       **_background_process_options())
            record["launcher_pid"] = process.pid
            from action_modules import LAUNCHERS
            LAUNCHERS[record["run_id"]] = process
            _atomic_write(self.runtime.path(record["run_id"]), record)
            return True
        except OSError as error:
            self._review(record, "wakeup-dispatch-failed:" + type(error).__name__)
            return False

    def safety_scan(self, limit=8):
        if type(limit) is not int or not 1 <= limit <= 32:
            raise ValueError("Safety scan dispatch limit must be between 1 and 32.")
        dispatched, reviewed = [], []
        with self.runtime.lock(recover=True):
            self.runtime.runs.recover_launches()
            records = [json.loads(path.read_text(encoding="utf-8")) for path in (self.runtime.root / "runs").glob("*/run.json")]
            ready, now = {}, time.time()
            by_id = {record["run_id"]: record for record in records}
            for record in records:
                execution = record.get("execution")
                if not execution:
                    continue
                if record["state"] == "running":
                    pid = execution.get("workerPid") or record.get("launcher_pid")
                    if (record.get("engine") == "module" and execution["phase"] in {"created", "dispatched"}
                            and not execution.get("workerPid") and (not pid or not process_alive(pid))):
                        self.prepare_schedule(record, record.get("planned_trigger") or {"kind": "timer", "at": now}, "dispatch-recovery")
                        continue
                    if not pid or not process_alive(pid):
                        self._review(record, "orphan-worker-unavailable")
                        reviewed.append(record["run_id"])
                    elif (now > record.get("deadline", now + 1) + 5 or
                          execution.get("lease_expires_at") is not None and now > execution["lease_expires_at"]):
                        _atomic_write(self.runtime.path(record["run_id"]).with_name("cancel.json"), {"requested": True})
                        self._review(record, "orphan-lease-or-deadline-exceeded")
                        reviewed.append(record["run_id"])
                    continue
                if record["state"] != "waiting":
                    continue
                checkpoint = record.get("checkpoint")
                if not checkpoint:
                    self._review(record, "waiting-checkpoint-unavailable")
                    reviewed.append(record["run_id"])
                    continue
                if self.runtime.cancelled(record):
                    record.update({"state": "cancelled", "ok": False, "completed_at": timestamp()})
                    record["execution"]["fence"] += 1
                    self.runtime.runs.transition(record, "completed", "waiting-cancelled", "none")
                    continue
                if checkpoint["state"] == "waiting":
                    trigger = checkpoint["trigger"]
                    if checkpoint.get("deadline") is not None and now >= checkpoint["deadline"]:
                        checkpoint["state"] = "expired"
                        if checkpoint["timeout_behavior"] == "cancel":
                            record.update({"state": "cancelled", "ok": False, "completed_at": timestamp()})
                            self.runtime.runs.transition(record, "completed", "checkpoint-expired-cancelled", "none")
                        else:
                            self._review(record, "checkpoint-deadline-expired")
                        reviewed.append(record["run_id"])
                        continue
                    if trigger["kind"] == "timer" and now >= trigger["at"]:
                        self._resolve(record, checkpoint, {"at": trigger["at"]}, "timer:" + checkpoint["checkpoint_id"])
                    elif trigger["kind"] == "dependency":
                        dependency = by_id.get(trigger["run_id"])
                        if (not dependency or dependency.get("execution", {}).get("version", 0) < trigger["expected_version"] or
                                trigger.get("invocation_fingerprint") is not None and dependency.get("execution", {}).get("invocationFingerprint") != trigger["invocation_fingerprint"]):
                            self._review(record, "dependency-identity-unavailable")
                            reviewed.append(record["run_id"])
                            continue
                        if dependency["state"] == "succeeded":
                            self._resolve(record, checkpoint, {"run_id": dependency["run_id"]}, "dependency:" + checkpoint["checkpoint_id"])
                        elif dependency["state"] in {"failed", "cancelled", "outcome_unknown"}:
                            self._review(record, "dependency-needs-review")
                            reviewed.append(record["run_id"])
                            continue
                if record["execution"]["phase"] == "ready" and checkpoint["state"] == "resolved":
                    group = record.get("project_id") or record.get("root_run_id", record["run_id"])
                    ready.setdefault(group, []).append(record)
            cursor_path = self.runtime.root / "wakeup-cursor.json"
            cursor = json.loads(cursor_path.read_text()) if cursor_path.exists() else {"project": ""}
            groups = sorted(ready)
            groups = [group for group in groups if group > cursor["project"]] + [group for group in groups if group <= cursor["project"]]
            active = sum(record.get("state") == "running" for record in records)
            for group in groups[:min(limit, max(0, 8 - active))]:
                record = min(ready[group], key=lambda value: value["checkpoint"]["created_at"])
                if self._dispatch(record):
                    dispatched.append(record["run_id"])
                else:
                    reviewed.append(record["run_id"])
                _atomic_write(cursor_path, {"project": group})
        return {"ok": True, "dispatched": dispatched, "reviewed": reviewed}

    def reconcile_run(self, run_id, expected_version, kind="manual", evidence=None, outcome=None):
        if kind not in RECONCILER_REGISTRY:
            raise ValueError("Unknown reconciler kind.")
        original = self.read(run_id)
        descriptor = original.get("execution", {}).get("contract", {}).get("reconciler", {"kind": "manual"})
        remote = None
        if kind not in {"manual", "process-status"}:
            if descriptor.get("kind") != kind:
                raise PermissionError("This reconciler is not declared by the pinned Action contract.")
            validate_reconciler(descriptor)
        if kind in {"remote-resource", "message-order"}:
            if original["state"] != "outcome_unknown" or original["execution"]["version"] != expected_version:
                raise ValueError("Reconciliation requires the current uncertain Run revision.")
            definition = self.runtime.definition(descriptor["lookup_action_id"])
            if (definition["content_hash"] != descriptor["lookup_revision"]
                    or not set(definition["effects"]).issubset({"pure", "local-read", "remote-read"})):
                raise PermissionError("Reconciliation lookup must be pinned and read-only.")
            query = self.runtime.call(definition["action_id"], descriptor["inputs"],
                "reconcile:" + run_id + ":" + str(expected_version), definition["content_hash"])
            remote = self.runtime.wait(query["run_id"])
        with self.runtime.lock():
            record = self.read(run_id)
            execution = record.get("execution", {})
            if record["state"] != "outcome_unknown" or execution.get("version") != expected_version:
                raise ValueError("Reconciliation requires the current uncertain Run revision.")
            evidence = evidence or {}
            if kind == "file-hash":
                workspace = Path(record["workspace"]).resolve()
                source = workspace / descriptor["path"]
                path = source.resolve()
                if not path.is_relative_to(workspace) or not path.is_file() or source.is_symlink():
                    raise PermissionError("Reconciliation can only verify files in this Run's workspace.")
                actual = hashlib.sha256(path.read_bytes()).hexdigest()
                if actual != descriptor["sha256"]:
                    raise ValueError("File effect does not match the proposed evidence.")
                Draft202012Validator(record["definition"]["output_schema"]).validate(descriptor["output"])
                record["output"] = descriptor["output"]
                evidence = {"path": descriptor["path"], "sha256": actual}
                outcome = "succeeded"
            elif kind == "process-status":
                pid = execution.get("workerPid") or record.get("launcher_pid")
                evidence = {"pid": pid, "alive": bool(pid and process_alive(pid))}
                outcome = "review"
            elif kind in {"remote-resource", "message-order"}:
                output = remote.get("output") if remote else None
                proven = remote and remote["state"] == "succeeded" and isinstance(output, dict) and output.get(descriptor["success_field"]) == descriptor["success_value"]
                evidence = {"lookup_run_id": remote["run_id"], "lookup_revision": descriptor["lookup_revision"]}
                outcome = "succeeded" if proven else "review"
                if proven:
                    Draft202012Validator(record["definition"]["output_schema"]).validate(descriptor["output"])
                    record["output"] = descriptor["output"]
            elif kind == "manual":
                if outcome not in {"succeeded", "failed", "cancelled", "review"} or not isinstance(evidence.get("reason"), str) or not evidence["reason"].strip():
                    raise ValueError("Manual reconciliation requires an explicit outcome and evidence reason.")
                if outcome == "succeeded":
                    Draft202012Validator(record["definition"]["output_schema"]).validate(evidence.get("output"))
                    record["output"] = evidence["output"]
            else:
                raise ValueError("Unknown reconciler kind.")
            record.setdefault("reconciliations", []).append({"kind": kind, "evidence": evidence, "outcome": outcome, "at": time.time(),
                                                            "expected_version": expected_version})
            if outcome == "review":
                self.runtime.runs.transition(record, "reconciling", "reconciliation-needs-review", "user")
            else:
                record.update({"state": outcome, "ok": outcome == "succeeded", "completed_at": timestamp()})
                self.runtime.runs.transition(record, "completed", "reconciled-" + outcome, "none")
        return self.runtime.runs.public(record)
