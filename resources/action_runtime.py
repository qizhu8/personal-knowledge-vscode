"""Typed PKM Actions and platform command adapters."""

import datetime
import hashlib
import json
import os
import platform
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import asyncio
import logging
import threading
from pathlib import Path
from urllib.parse import unquote, urlsplit

from recipe_runtime import _atomic_write, _background_process_options
from action_modules import ModuleRuntime, process_alive
from action_run_store import action_contract


def cosmos_location(uri, accounts=None):
    if not isinstance(uri, str):
        raise ValueError("Cosmos URI must be a string.")
    parsed = urlsplit(uri)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise ValueError("Expected a credential-free HTTPS Cosmos browser URL.")
    if parsed.query or parsed.fragment:
        raise ValueError("Cosmos URI must not contain a query or fragment.")
    parts = unquote(parsed.path).split("/")
    if len(parts) < 5 or parts[1] != "cosmos" or any(part in {".", ".."} for part in parts):
        raise ValueError("Expected /cosmos/<vc>/shares/<vc>/... without traversal.")
    account = (accounts or {}).get((parsed.hostname, parts[2].lower()))
    if not account:
        raise ValueError("Cosmos VC has no verified ADL account mapping.")
    remote = "/" + "/".join(parts[3:])
    if parts[3] != "shares" or any(ord(character) < 32 for character in remote) or "\\" in remote:
        raise ValueError("Invalid Cosmos share path.")
    return {"account": account, "path": posixpath.normpath(remote)}


def cosmos_command(action_id, inputs, accounts=None):
    location = cosmos_location(inputs["uri"], accounts)
    arguments = ["dls", "fs"]
    if action_id == "cosmos.directory.list":
        arguments += ["list", "--account", location["account"], "--path", location["path"]]
    elif action_id in {"cosmos.artifact.upload", "cosmos.artifact.download"}:
        uploading = action_id.endswith("upload")
        local = inputs["local_path"]
        if not isinstance(local, str) or not local or "\x00" in local:
            raise ValueError("local_path must be a non-empty path.")
        arguments += ["upload" if uploading else "download", "--account", location["account"],
                      "--source-path", local if uploading else location["path"],
                      "--destination-path", location["path"] if uploading else local]
        overwrite = inputs.get("overwrite", False)
        if not isinstance(overwrite, bool):
            raise ValueError("overwrite must be a boolean.")
        if overwrite:
            arguments += ["--overwrite"]
        if "thread_count" in inputs:
            if type(inputs["thread_count"]) is not int or not 1 <= inputs["thread_count"] <= 32:
                raise ValueError("thread_count must be an integer between 1 and 32.")
            arguments += ["--thread-count", str(inputs["thread_count"])]
    else:
        raise ValueError("Unsupported Cosmos storage Action.")
    return {"program": "az", "args": arguments + ["--output", "json", "--only-show-errors"]}


DEFINITIONS = {
    "cosmos.artifact.upload": {
        "description": "Upload a local file or folder to Cosmos using az dls fs upload. 上传文件 文件夹",
        "required": ["uri", "local_path"], "effect": "remote-write",
    },
    "cosmos.artifact.download": {
        "description": "Download a Cosmos file or folder using az dls fs download. 下载文件 文件夹",
        "required": ["uri", "local_path"], "effect": "local-write",
    },
    "cosmos.directory.list": {
        "description": "List Cosmos directory contents using az dls fs list. 查看目录 文件夹内容",
        "required": ["uri"], "effect": "read",
    },
}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _contained(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


class ActionRuntime:
    def __init__(self, store, program=None):
        self.program = program or shutil.which("az")
        self.modules = ModuleRuntime(store)
        self.root = self.modules.root
        self.runs = self.modules.runs
        self.scheduler_error = None
        self._scheduler = None
        self._scheduler_lock = threading.Lock()

    def start_scheduler(self):
        with self._scheduler_lock:
            if self._scheduler is not None and self._scheduler.is_alive():
                return
            self.scheduler_error = None

            def service():
                try:
                    while True:
                        self.modules.recovery.safety_scan()
                        with self._scheduler_lock:
                            active = [json.loads(path.read_text(encoding="utf-8"))
                                      for path in (self.root / "runs").glob("*/run.json")]
                            if not any(item.get("engine") == "module" and item["state"] in {"running", "waiting"} for item in active):
                                self._scheduler = None
                                return
                        time.sleep(0.5)
                except (OSError, ValueError, RuntimeError) as error:
                    self.scheduler_error = str(error)
                    logging.getLogger(__name__).exception("Action scheduler stopped; original Runs require a safety scan.")

            self._scheduler = threading.Thread(target=service, daemon=True, name="pkm-action-scheduler")
            self._scheduler.start()

    def cosmos_accounts(self):
        file = self.root / "cosmos-bindings.json"
        if not file.exists():
            return {}
        if file.is_symlink():
            raise PermissionError("Private Cosmos bindings must not be a symlink.")
        config = json.loads(file.read_text(encoding="utf-8"))
        if config.get("schema") != "pkm.action.cosmos-bindings/v1":
            raise ValueError("Invalid private Cosmos binding configuration.")
        return {(item["host"], item["vc"]): item["account"] for item in config["bindings"]}

    def configure_cosmos(self, bindings):
        if not isinstance(bindings, list) or not 1 <= len(bindings) <= 100:
            raise ValueError("Provide 1-100 explicit private Cosmos bindings.")
        normalized = []
        identities = set()
        for item in bindings:
            if not isinstance(item, dict) or set(item) != {"host", "vc", "account"}:
                raise ValueError("A binding requires host, vc and account.")
            if any(not isinstance(item[key], str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", item[key])
                   for key in ["host", "vc", "account"]):
                raise ValueError("Use lowercase host, VC and account names without URLs or credentials.")
            identity = (item["host"], item["vc"])
            if identity in identities:
                raise ValueError("Duplicate private Cosmos binding.")
            identities.add(identity)
            normalized.append(dict(item))
        with self.modules.lock():
            path = self.root / "cosmos-bindings.json"
            if path.is_symlink():
                raise PermissionError("Private Cosmos bindings must not be a symlink.")
            if (path.exists() and self.cosmos_accounts() != {(item["host"], item["vc"]): item["account"] for item in normalized}
                    and (self.root / "policy.json").exists()):
                raise PermissionError("Revoke existing operator path grants before changing private Cosmos bindings.")
            _atomic_write(path, {"schema": "pkm.action.cosmos-bindings/v1", "bindings": normalized})
            path.chmod(0o600)
        return {"ok": True, "private": True, "bindings_count": len(normalized)}

    def definition(self, action_id):
        if action_id not in DEFINITIONS:
            return self.modules.definition(action_id)
        definition = DEFINITIONS[action_id]
        properties = {"uri": {"type": "string", "format": "uri"}}
        if "local_path" in definition["required"]:
            properties.update({"local_path": {"type": "string"}, "overwrite": {"type": "boolean", "default": False}})
            properties.update({"timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 86400, "default": 300},
                               "thread_count": {"type": "integer", "minimum": 1, "maximum": 32}})
        value = {"schema": "pkm.action.definition/v1", "action_id": action_id,
                 "visibility": "private", "exportable": False,
                 "source_id": "pkm://actions/" + action_id, "version": 1,
                 "description": definition["description"], "effect": definition["effect"],
                 "input_schema": {"type": "object", "properties": properties,
                                  "required": definition["required"], "additionalProperties": False},
                 "backend": "az-dls-fs", "implementation_hash": _digest({
                     "action_runtime": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     "run_store": hashlib.sha256(Path(__file__).with_name("action_run_store.py").read_bytes()).hexdigest(),
                     "recovery": hashlib.sha256(Path(__file__).with_name("action_recovery.py").read_bytes()).hexdigest(),
                     "recipe_runtime": hashlib.sha256(Path(__file__).with_name("recipe_runtime.py").read_bytes()).hexdigest(),
                 })}
        value["content_hash"] = _digest(value)
        return value

    def environment_fingerprint(self):
        executable = Path(self.program).resolve() if self.program else None
        return _digest({"platform": platform.system(), "architecture": platform.machine(),
                        "python": sys.version, "program": str(executable), "private_bindings": _digest(
                            sorted([list(key) + [value] for key, value in self.cosmos_accounts().items()])),
                        "program_hash": hashlib.sha256(executable.read_bytes()).hexdigest()
                        if executable and executable.is_file() else None})

    def enabled_platform_actions(self):
        path = self.root / "policy.json"
        try:
            policy = json.loads(path.read_text(encoding="utf-8"))
            if policy.get("schema") != "pkm.action.policy/v1":
                return []
            return sorted({grant["action_id"] for grant in policy.get("grants", [])
                           if isinstance(grant, dict) and grant.get("action_id") in DEFINITIONS and grant.get("remote_root")})
        except (OSError, ValueError, TypeError):
            return []

    def private_catalog(self):
        if not self.cosmos_accounts():
            return []
        enabled = set(self.enabled_platform_actions())
        return [{**self.definition(action_id), "category": "Private/Cosmos", "read_only": True,
                 "editable": False, "direct_only": True, "language": "Azure CLI", "languages": ["Azure CLI"],
                 "execution_contract": action_contract(self.definition(action_id)),
                 "availability": self.availability(action_id) if action_id in enabled else {
                     "state": "blocked", "reason": "Private account binding is configured, but this Action has no operator path grant. Configure explicit local/remote roots before qualification or execution."}}
                for action_id in sorted(DEFINITIONS)]

    def list_runs(self, limit=50):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("Run history limit must be between 1 and 200.")
        records = [json.loads(path.read_text(encoding="utf-8")) for path in (self.root / "runs").glob("*/run.json")]
        records = [record for record in records if not record.get("parent_run_id") and not record.get("validation")]
        records.sort(key=lambda record: record.get("started_at", ""), reverse=True)
        fields = ("run_id", "action_id", "state", "userState", "nextOwner", "reasonCode", "started_at", "completed_at", "error")
        return {"ok": True, "runs": [{key: value for key, value in self.get(record["run_id"]).items() if key in fields}
                                   for record in records[:limit]], "total": len(records)}

    def configure_policy(self, grants):
        if not isinstance(grants, list) or not grants:
            raise ValueError("Provide explicit operator path grants.")
        path = self.root / "policy.json"
        policy = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema": "pkm.action.policy/v1", "grants": []}
        if policy.get("schema") != "pkm.action.policy/v1":
            raise ValueError("Existing operator policy is invalid; refusing replacement.")
        approved = []
        for grant in grants:
            if not isinstance(grant, dict) or grant.get("action_id") not in DEFINITIONS or set(grant) - {"action_id", "remote_root", "local_root", "allow_overwrite"}:
                raise ValueError("Invalid operator grant.")
            cosmos_location(grant["remote_root"], self.cosmos_accounts())
            if "allow_overwrite" in grant and type(grant["allow_overwrite"]) is not bool:
                raise ValueError("allow_overwrite must be a boolean.")
            normalized = dict(grant)
            if grant["action_id"] != "cosmos.directory.list":
                local = Path(grant["local_root"]).expanduser()
                if local.is_symlink() or not local.is_dir():
                    raise ValueError("An existing non-symlink local root is required.")
                normalized["local_root"] = str(local.resolve())
            approved.append(normalized)
        for grant in approved:
            if grant not in policy["grants"]:
                policy["grants"].append(grant)
        self.root.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, policy)
        return {"ok": True, "approved_grants": approved}

    def validate(self, action_id, content_hash, inputs=None):
        if action_id not in DEFINITIONS:
            return self.modules.validate(action_id, content_hash)
        if self.definition(action_id)["content_hash"] != content_hash:
            raise ValueError("Action definition changed before qualification.")
        definition, inputs = self._authorize(action_id, inputs)
        before = self.environment_fingerprint()
        upload_proof = None
        if action_id == "cosmos.artifact.download":
            upload_validation = self.root / "validations" / "cosmos.artifact.upload.json"
            if not upload_validation.exists() or self.availability("cosmos.artifact.upload")["state"] != "ready":
                raise ValueError("Download qualification requires a current separately approved upload/read-back fixture.")
            upload_proof = json.loads(upload_validation.read_text(encoding="utf-8")).get("proof", {})
            if (inputs.get("overwrite", False) or upload_proof.get("inputs", {}).get("uri") != inputs["uri"]
                    or not re.fullmatch(r"[0-9a-f]{64}", upload_proof.get("sha256", ""))):
                raise ValueError("Download qualification must use the exact previously verified fixture and a new local destination.")
        source_digest = None
        if action_id == "cosmos.artifact.upload":
            source = Path(inputs["local_path"])
            if inputs.get("overwrite", False) or not source.is_file() or source.is_symlink() or source.stat().st_size > 1024 * 1024:
                raise ValueError("Upload qualification requires a new, non-overwriting regular file of at most 1 MiB.")
            source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
        run = self._call(action_id, inputs, "qualification-" + uuid.uuid4().hex, content_hash)
        result = self.wait(run["run_id"])
        if result["state"] != "succeeded":
            raise RuntimeError("Qualification invocation did not succeed; reconcile run " + run["run_id"])
        proof = {"run_id": run["run_id"], "inputs": inputs}
        if action_id == "cosmos.artifact.upload":
            location = cosmos_location(inputs["uri"], self.cosmos_accounts())
            with tempfile.TemporaryDirectory(prefix="cosmos-qualification-", dir=str(self.modules.workspace())) as temporary:
                destination = Path(temporary) / "verified-file"
                command = [self.program, "dls", "fs", "download", "--account", location["account"],
                           "--source-path", location["path"], "--destination-path", str(destination),
                           "--thread-count", "1", "--output", "json", "--only-show-errors"]
                verification = subprocess.run(command, capture_output=True, text=True, timeout=120)
                if verification.returncode or not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != source_digest:
                    raise RuntimeError("Uploaded fixture read-back failed; reconcile existing run " + run["run_id"])
            if hashlib.sha256(source.read_bytes()).hexdigest() != source_digest:
                raise RuntimeError("Qualification source changed during transfer.")
            proof["sha256"] = source_digest
        elif action_id == "cosmos.artifact.download":
            destination = Path(inputs["local_path"])
            if (not destination.is_file() or destination.is_symlink() or destination.stat().st_size > 1024 * 1024
                    or hashlib.sha256(destination.read_bytes()).hexdigest() != upload_proof["sha256"]):
                raise RuntimeError("Downloaded fixture does not match the approved round-trip SHA-256.")
            proof["sha256"] = upload_proof["sha256"]
        elif not isinstance(result.get("output"), list):
            raise ValueError("Directory-list qualification did not return a complete list.")
        if before != self.environment_fingerprint():
            raise RuntimeError("Execution environment changed during qualification.")
        record = {"schema": "pkm.action.validation/v1", "action_id": action_id, "kind": "smoke", "status": "passed",
                  "content_hash": definition["content_hash"], "environment_fingerprint": before, "proof": proof,
                  "expires_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=24)).isoformat()}
        _atomic_write(self.root / "validations" / (action_id + ".json"), record)
        return {"ok": True, "state": "ready", "proof": proof}

    def availability(self, action_id):
        definition = self.definition(action_id)
        if not self.program or not Path(self.program).is_file():
            return {"state": "blocked", "reason": "Azure CLI is unavailable."}
        path = self.root / "validations" / (action_id + ".json")
        if not path.exists():
            return {"state": "unverified", "reason": "No operator-owned smoke-test evidence for this environment."}
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            expires = datetime.datetime.fromisoformat(record["expires_at"])
            valid = (record.get("schema") == "pkm.action.validation/v1"
                     and record.get("action_id") == action_id
                     and record.get("content_hash") == definition["content_hash"]
                     and record.get("environment_fingerprint") == self.environment_fingerprint()
                     and record.get("kind") == "smoke"
                     and expires > datetime.datetime.now(datetime.timezone.utc))
        except (ValueError, TypeError, KeyError, OSError):
            valid = False
            record = {}
        if not valid:
            return {"state": "stale", "reason": "Validation is invalid, expired or does not match the implementation/environment."}
        return {"state": "ready" if record.get("status") == "passed" else "failed"}

    def retrieve(self, task, limit=1):
        if not isinstance(task, str) or not task.strip() or type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("A non-empty task and limit between 1 and 10 are required.")
        words = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", task.lower())
        matches = []
        definitions = [self.definition(action_id) for action_id in self.enabled_platform_actions()] + self.modules.list()
        for definition in definitions:
            action_id = definition["action_id"]
            text = action_id + " " + definition["description"].lower()
            score = sum(word in text for word in words)
            if score:
                availability = self.availability(action_id) if action_id in DEFINITIONS else self.modules.availability(action_id)
                matches.append({**definition, "availability": availability, "score": score})
        matches.sort(key=lambda item: (-item["score"], item["action_id"]))
        ambiguous = len(matches) > 1 and matches[0]["score"] == matches[1]["score"]
        return {"schema": "pkm.action.retrieval/v1", "ok": True, "no_match": not matches,
                "ambiguous": ambiguous, "selected_action_id": matches[0]["action_id"]
                if matches and not ambiguous and matches[0]["availability"]["state"] == "ready" else None,
                "candidates": matches[:max(limit, 2 if ambiguous else 1)], "truncated": len(matches) > max(limit, 2 if ambiguous else 1)}

    def _authorize(self, action_id, inputs):
        definition = self.definition(action_id)
        schema = definition["input_schema"]
        if not isinstance(inputs, dict) or set(inputs) - set(schema["properties"]) or any(key not in inputs for key in schema["required"]):
            raise ValueError("Inputs must match the Action input schema.")
        if "overwrite" in inputs and type(inputs["overwrite"]) is not bool:
            raise ValueError("overwrite must be a boolean.")
        if "timeout_seconds" in inputs and (type(inputs["timeout_seconds"]) is not int or not 1 <= inputs["timeout_seconds"] <= 86400):
            raise ValueError("timeout_seconds must be an integer between 1 and 86400.")
        if "thread_count" in inputs and (type(inputs["thread_count"]) is not int or not 1 <= inputs["thread_count"] <= 32):
            raise ValueError("thread_count must be an integer between 1 and 32.")
        if "local_path" in inputs and (not isinstance(inputs["local_path"], str) or not inputs["local_path"]):
            raise ValueError("local_path must be a non-empty string.")
        remote = cosmos_location(inputs["uri"], self.cosmos_accounts())
        local_input = Path(inputs["local_path"]).expanduser() if "local_path" in inputs else None
        if local_input is not None and local_input.is_symlink():
            raise PermissionError("Transfer paths must not be symlinks.")
        local = local_input.resolve() if local_input is not None else None
        policy_path = self.root / "policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8")) if policy_path.exists() else {}
        if policy.get("schema") != "pkm.action.policy/v1":
            raise PermissionError("An operator-managed Action policy is required.")
        for grant in policy.get("grants", []):
            if grant.get("action_id") != action_id:
                continue
            approved = cosmos_location(grant["remote_root"], self.cosmos_accounts())
            if remote["account"] != approved["account"] or not _contained(remote["path"], approved["path"]):
                continue
            if local is not None:
                if not grant.get("local_root") or not local.is_relative_to(Path(grant["local_root"]).expanduser().resolve()):
                    continue
                if inputs.get("overwrite", False) and not grant.get("allow_overwrite", False):
                    continue
                if action_id.endswith("upload"):
                    if not local.is_file() and not local.is_dir():
                        raise ValueError("Upload source must be an existing regular file or directory.")
                    files = [local] if local.is_file() else list(local.rglob("*"))
                    if any(item.is_symlink() for item in files):
                        raise PermissionError("Upload folders must not contain symlinks.")
                elif local.exists() and not inputs.get("overwrite", False):
                    raise FileExistsError("Download destination already exists; overwrite was not authorized.")
                inputs = {**inputs, "local_path": str(local)}
            return definition, inputs
        raise PermissionError("Action paths are outside the operator-authorized scope.")

    def call(self, action_id, inputs, idempotency_key, content_hash, trigger=None, project_id=None):
        if action_id not in DEFINITIONS:
            return self.modules.call(action_id, inputs, idempotency_key, content_hash, trigger=trigger, project_id=project_id)
        if trigger is not None:
            raise ValueError("Scheduled platform Actions require a declared pipeline wrapper; direct platform replay is not supported.")
        if self.availability(action_id)["state"] != "ready":
            raise PermissionError("Action is not validated for this implementation and execution environment.")
        return self._call(action_id, inputs, idempotency_key, content_hash)

    def _call(self, action_id, inputs, idempotency_key, content_hash):
        definition, inputs = self._authorize(action_id, inputs)
        if content_hash != definition["content_hash"]:
            raise ValueError("Action definition changed; retrieve and pin its current content_hash.")
        if not self.program or not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 200:
            raise ValueError("Azure CLI and an idempotency_key of 1-200 characters are required.")
        command = cosmos_command(action_id, inputs, self.cosmos_accounts())
        fingerprint = _digest({"action_id": action_id, "inputs": inputs, "content_hash": content_hash})
        self.root.mkdir(parents=True, exist_ok=True)
        keys = self.root / "keys"
        keys.mkdir(exist_ok=True)
        key_path = keys / (_digest(idempotency_key) + ".json")
        run_id = "action_run_" + uuid.uuid4().hex
        with self.modules.lock():
            self.runs.recover_launches()
            if key_path.exists():
                existing = json.loads(key_path.read_text(encoding="utf-8"))
                if existing["fingerprint"] != fingerprint:
                    raise ValueError("Idempotency key was already used for different inputs.")
                return self.get(existing["run_id"])
            directory = self.root / "runs" / run_id
            directory.mkdir(parents=True)
            spec = {**command, "program": self.program, "timeoutSeconds": inputs.get("timeout_seconds", 300), "maxOutputBytes": 65536}
            _atomic_write(directory / "spec.json", spec)
            record = {"schema": "pkm.action.run/v1", "ok": True, "run_id": run_id, "action_id": action_id,
                      "content_hash": content_hash, "inputs": inputs, "state": "running", "engine": "platform",
                      "workspace": str(directory), "environment_fingerprint": self.environment_fingerprint(),
                      "command_fingerprint": _digest(spec),
                      "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            self.runs.prepare(record, key_path, fingerprint, definition)
            try:
                self.runs.transition(record, "dispatched", "worker-launch")
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", str(directory)],
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           close_fds=True, **_background_process_options())
                record["launcher_pid"] = process.pid
                _atomic_write(directory / "run.json", record)
            except OSError as error:
                record.update({"ok": False, "state": "failed", "error": str(error)})
                self.runs.transition(record, "completed", "dispatch-failed", "none")
        return self.get(run_id)

    def wait(self, run_id):
        record = self.get(run_id)
        deadline = time.monotonic() + record.get("inputs", {}).get("timeout_seconds", 300) + 10
        while record["state"] == "running":
            if time.monotonic() > deadline:
                self.cancel(run_id)
                raise TimeoutError("Reconcile existing Action run " + run_id + "; do not submit a replacement.")
            time.sleep(0.25)
            record = self.get(run_id)
        return record

    def get(self, run_id):
        if not isinstance(run_id, str) or not re.fullmatch(r"action_run_[0-9a-f]{32}", run_id):
            raise ValueError("Invalid Action run ID.")
        directory = self.root / "runs" / run_id
        if not (directory / "run.json").exists():
            return {"ok": False, "run_id": run_id, "state": "outcome_unknown", "error": "Run record is unavailable; do not launch a replacement."}
        record = json.loads((directory / "run.json").read_text(encoding="utf-8"))
        if record.get("engine") == "module":
            return self.modules.get(run_id)
        result_path = directory / "result.json"
        if result_path.exists() and not record.get("execution"):
            result = json.loads(result_path.read_text(encoding="utf-8"))
            uncertain = result.get("timed_out") or result.get("cancelled") or not result.get("ok") and record.get("action_id") != "cosmos.directory.list"
            record.update({"ok": bool(result.get("ok")), "state": "outcome_unknown" if uncertain else "succeeded" if result.get("ok") else "failed",
                           "completed_at": result.get("completed_at"), "exit_code": result.get("exit_code"),
                           "diagnostics": {key: result.get(key) for key in ["error", "stderr", "stdout_truncated", "stderr_truncated"]}})
            if result.get("ok") and not result.get("stdout_truncated"):
                try:
                    output = json.loads(result.get("stdout") or "null")
                except ValueError:
                    record.update({"ok": False, "state": "failed" if record["action_id"] == "cosmos.directory.list" else "outcome_unknown", "error": "CLI did not return valid JSON."})
                else:
                    record["output"] = output
            elif result.get("ok"):
                record.update({"ok": False, "state": "failed" if record["action_id"] == "cosmos.directory.list" else "outcome_unknown", "incomplete": True, "error": "CLI output exceeded its bound; completeness cannot be claimed."})
            _atomic_write(directory / "run.json", record)
        elif record["state"] == "running" and (record.get("execution") or record.get("launcher_pid")):
            pid = record.get("execution", {}).get("workerPid") or record.get("launcher_pid")
            if not pid or not process_alive(pid):
                record.update({"ok": False, "state": "outcome_unknown", "error": "Worker exited without a result; reconciliation required."})
        return self.runs.public(record)

    def recover(self):
        result = self.modules.recover()
        with self.modules.lock():
            for path in (self.root / "runs").glob("*/run.json"):
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("engine") == "module" or record.get("state") != "running":
                    continue
                pid = record.get("execution", {}).get("workerPid") or record.get("launcher_pid")
                if not pid or not process_alive(pid):
                    record.update({"ok": False, "state": "outcome_unknown", "error": "Worker unavailable; reconcile the original Run before retry."})
                    self.runs.transition(record, "reconciling", "worker-unavailable", "user")
                    if not record.get("execution"):
                        _atomic_write(path, record)
                    result["reconciled"].append(record["run_id"])
        return result

    def cancel(self, run_id):
        record = self.get(run_id)
        if record.get("engine") == "module":
            return self.modules.cancel(run_id)
        if record.get("state") == "running":
            _atomic_write(self.root / "runs" / run_id / "cancel.json", {"requested": True})
            return {**record, "cancel_requested": True, "remote_rollback": False}
        return record


def register_action_tools(mcp, store, runtime=None):
    runtime = runtime or ActionRuntime(store)
    runtime.modules.proposal_mode = True
    runtime.start_scheduler()

    def action_retrieve(task: str, limit: int = 1):
        """Find callable Actions with typed inputs; never select an ambiguous match automatically."""
        return runtime.retrieve(task, limit)

    def action_templates():
        """List public preinstalled wait/input/alias Actions and the pinned read-only polling template."""
        return runtime.modules.templates()

    def action_template_create(action_id: str, parameters: dict):
        """Submit a template-based Action proposal for operator admission. Never registers or grants execution; wait for human approval before qualification."""
        return runtime.modules.template_create(action_id, parameters)

    def action_cosmos_configure(bindings: list[dict]):
        """Set explicit PRIVATE local Cosmos host/VC/account bindings; never exported or provided by default. Operator approval required."""
        return runtime.configure_cosmos(bindings)

    async def action_run_wait(run_id: str, wait_seconds: float = 30, after_sequence: int | None = None):
        """Wait without model polling for the ORIGINAL Run. A wait_expired result is not completion or cancellation; attach to that Run again."""
        if type(wait_seconds) not in {int, float} or not 0 <= wait_seconds <= 300:
            raise ValueError("wait_seconds must be finite and between 0 and 300.")
        until = time.monotonic() + wait_seconds
        from action_monitoring import event_page
        if after_sequence is not None and (type(after_sequence) is not int or after_sequence < 0):
            raise ValueError("after_sequence must be a nonnegative integer.")
        while True:
            runtime.modules.recovery.safety_scan()
            record = runtime.get(run_id)
            delivery = event_page(record, after_sequence or 0)
            if record["state"] not in {"running", "waiting"}:
                return {**record, "event_delivery": delivery}
            if after_sequence is not None and (delivery["events"] or delivery["gap"]):
                return {**record, "event_update": True, "completed": False, "event_delivery": delivery}
            if time.monotonic() >= until:
                return {**record, "wait_expired": True, "completed": False, "event_delivery": delivery}
            await asyncio.sleep(min(0.25, max(0, until - time.monotonic())))

    def action_call(action_id: str, inputs: dict, idempotency_key: str, content_hash: str, trigger: dict | None = None, project_id: str | None = None):
        """Invoke a pinned Action inside operator-managed path grants; return a durable run ID."""
        result = runtime.call(action_id, inputs, idempotency_key, content_hash, trigger, project_id)
        runtime.start_scheduler()
        return result

    def action_run_checkpoints(run_id: str, include_history: bool = False):
        """Inspect typed proposals, evidence, owners, deadlines and exact resume tokens on the original Run."""
        return runtime.modules.recovery.checkpoints(run_id, include_history)

    def action_checkpoint_respond(run_id: str, checkpoint_id: str, resume_token: str, proposal_digest: str, answer: dict, event_key: str):
        """Resolve an exact checkpoint once; a response never grants new effect permissions."""
        return runtime.modules.recovery.respond_checkpoint(run_id, checkpoint_id, resume_token, proposal_digest, answer, event_key)

    def action_run_wake(run_id: str, event_key: str, event_name: str):
        """Deliver one deduplicated event to its original waiting Run, not a replacement invocation."""
        return runtime.modules.recovery.wake_run(run_id, event_key, event_name)

    def action_run_safety_scan(limit: int = 8):
        """Recover missed timers/dependencies fairly and fence orphans without replaying unknown effects."""
        return runtime.modules.recovery.safety_scan(limit)

    def action_run_reconcile(run_id: str, expected_version: int, kind: str = "manual", evidence: dict | None = None, outcome: str | None = None):
        """Reconcile effect evidence at an exact Run revision; unsupported remote lookup requires manual review."""
        return runtime.modules.recovery.reconcile_run(run_id, expected_version, kind, evidence, outcome)

    def action_run_get(run_id: str):
        """Read a durable Action run; submission is not transfer verification."""
        return runtime.get(run_id)

    def action_run_events(run_id: str, after_sequence: int = 0):
        """Deliver retained monitor notifications after a durable cursor; repeat the cursor to replay after reconnect. Gaps are explicit."""
        from action_monitoring import event_page
        return {"run_id": run_id, **event_page(runtime.get(run_id), after_sequence)}

    def action_run_cancel(run_id: str):
        """Request local invocation cancellation; remote writes are not rolled back."""
        return runtime.cancel(run_id)

    def action_capabilities():
        """Discover Action registration, qualification, nesting and artifact lifecycle; workspace selection is a machine setting."""
        from action_authoring import authoring_contract
        import socket
        return {"schema": "pkm.action.capabilities/v1", "version": "1.0.0", "registry": str(runtime.modules.registry),
                "authoring": authoring_contract(),
                "execution_host": {"hostname": socket.gethostname(), "platform": platform.system(),
                    "architecture": platform.machine(), "filesystem": "Paths refer to this MCP execution host, not the caller shell.",
                    "identity": "Execution host OS account; credentials stay on that host.",
                    "selection": "Operator-managed local workspace/toolchain settings; not a per-call host selector."},
                "scheduler_error": runtime.scheduler_error,
                "workspace_setting": "personalKnowledge.actions.workspaceRoots", "settings": runtime.modules.settings(),
                "platform": platform.system(), "trusted_host_execution_is_sandboxed": False,
                "tools": [function.__name__ for function in tools], "builtins": [item["action_id"] for item in runtime.modules.list()],
                "basic_components": runtime.modules.components(), "enabled_platform_actions": runtime.enabled_platform_actions()}

    def action_definition_check(definition: dict):
        """Check definition/schema and pinned dependencies without saving, executing or granting; readiness is checked separately."""
        return runtime.modules.definition_check(definition)

    def action_register(definition: dict):
        """Submit a versioned Action proposal, not a formal library registration. Return pending_operator_approval; ask the operator to approve it in Action Library and wait. The previous approved version is unchanged. No validation, invocation or automatic retry before approval."""
        return runtime.modules.register(definition)

    def action_proposals():
        """Read pending operator-review proposals. No registration, approval or execution; the previous approved Action remains in use."""
        return runtime.modules.proposal_list()

    def action_get(action_id: str):
        """Read a stable Action definition and its current target-environment readiness."""
        definition = runtime.definition(action_id)
        return {**definition, "execution_contract": action_contract(definition), "availability": runtime.availability(action_id)
                if action_id in DEFINITIONS else runtime.modules.availability(action_id)}

    def action_validate(action_id: str, content_hash: str, inputs: dict | None = None):
        """Non-builtin public Actions require the Workbench Validate flow: Agent code review, consented smoke tests, then automatic admission. Never self-grant."""
        return runtime.validate(action_id, content_hash, inputs)

    def action_artifact_import(local_path: str):
        """Borrow a regular file inside the user-configured workspace; GC never deletes the original."""
        return runtime.modules.import_artifact(local_path)

    def action_artifact_export(artifact_id: str, destination: str):
        """Export to a new user-owned file inside the selected workspace; never overwrite existing data."""
        return runtime.modules.export_artifact(artifact_id, destination)

    def action_run_gc(run_id: str, release_outputs: bool = False):
        """Collect only unreferenced runtime-owned files; releasing outputs explicitly invalidates their artifact references."""
        return runtime.modules.gc(run_id, release_outputs)

    def action_run_recover():
        """Reconcile abandoned local workers and pending cleanup; never replay unknown remote mutations."""
        return runtime.recover()

    def action_validation_enqueue(action_id: str, content_hash: str, priority: str = "demand", allow_effects: bool = False):
        """Non-builtin Actions return ACTION_CODE_REVIEW_REQUIRED. Ask the operator to click the Workbench flask: Agent review precedes smoke tests and admission."""
        return runtime.modules.queue_enqueue(action_id, content_hash, priority, allow_effects)

    def action_validation_status():
        """Read durable build/test queue progress, deduplication and target-host outcomes."""
        return runtime.modules.queue_status()

    def action_validation_cancel(job_id: str):
        """Cancel queued qualification or signal an active local test; never promise remote rollback."""
        return runtime.modules.queue_cancel(job_id)

    def action_validation_resume():
        """Resume queued validation; crashed active jobs require reconciliation and are never replayed."""
        return runtime.modules.queue_start()

    def action_module_sets():
        """List installed optional plugin packages without loading disabled definitions."""
        return runtime.modules.module_set_list()

    def action_module_set_load(module_set_id: str, version: int, enabled: bool = True):
        """Enable or unload one immutable ModuleSet version; installation is not readiness."""
        return runtime.modules.module_set_load(module_set_id, version, enabled)

    def action_module_set_import(local_path: str):
        """Check and install a bounded package disabled; never import host credentials or validation."""
        return runtime.modules.module_set_import(local_path)

    def action_module_set_export(module_set_id: str, version: int, action_ids: list[str], destination: str, name: str = "", provenance: dict | None = None):
        """Export selected portable definitions and required assets, not the entire catalog or host state."""
        return runtime.modules.module_set_export(module_set_id, version, action_ids, destination, name, provenance)

    def action_module_set_remove(module_set_id: str, version: int):
        """Remove only a disabled installed package version, never caller files or retained runs."""
        return runtime.modules.module_set_remove(module_set_id, version)

    def action_implementation_select(action_id: str, implementation_id: str):
        """Select an explicit target-host binding when compatible implementations are ambiguous."""
        return runtime.modules.implementation_select(action_id, implementation_id)

    def action_graph_check(graph: dict):
        """Validate typed ports, pinned blocks, parameters and acyclic connections without executing code."""
        return runtime.modules.graph_definition(graph)

    def action_graph_save(graph: dict):
        """Submit a graphical composition proposal. It is not callable until operator admission and qualification."""
        return runtime.modules.graph_save(graph)

    tools = [action_retrieve, action_call, action_run_get, action_run_cancel, action_capabilities, action_definition_check, action_register, action_proposals,
             action_templates, action_template_create, action_cosmos_configure, action_run_wait,
             action_get, action_validate, action_artifact_import, action_artifact_export, action_run_gc, action_run_recover,
             action_validation_enqueue, action_validation_status, action_validation_cancel, action_validation_resume,
             action_module_sets, action_module_set_load, action_module_set_import, action_module_set_export, action_module_set_remove,
             action_implementation_select, action_graph_check, action_graph_save, action_run_checkpoints,
             action_checkpoint_respond, action_run_wake, action_run_safety_scan, action_run_reconcile, action_run_events]
    for function in tools:
        function.__annotations__["return"] = dict
        mcp.tool(annotations={"readOnlyHint": function in [action_retrieve, action_run_get, action_get, action_capabilities, action_definition_check, action_proposals,
                                 action_module_sets, action_graph_check, action_run_checkpoints, action_templates, action_run_events]})(function)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--worker":
        raise SystemExit("Only the managed Action worker entry is supported.")
    from recipe_runtime import _execute_command_worker

    directory = Path(sys.argv[2])
    spec_path = directory / "spec.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    runtime = ActionRuntime(directory.parents[4], spec["program"])
    with runtime.modules.lock():
        record = runtime.runs.claim(directory.name)
        if _digest(spec) != record["command_fingerprint"] or runtime.environment_fingerprint() != record["environment_fingerprint"]:
            record.update({"state": "failed", "ok": False, "error": "Pinned Action command or environment changed before dispatch."})
            runtime.runs.finish(record)
            raise ValueError(record["error"])
    spec["cancelPath"] = str(directory / "cancel.json")
    _atomic_write(spec_path, spec)
    with runtime.modules.recovery.lease(record):
        _execute_command_worker(spec_path, directory / "result.json")
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    effects = record["execution"]["contract"]["effects"]
    uncertain = result.get("timed_out") or result.get("cancelled") or not result.get("ok") and effects != ["read"]
    record.update({"ok": bool(result.get("ok")) and not uncertain,
                   "state": "outcome_unknown" if uncertain else "succeeded" if result.get("ok") else "failed",
                   "completed_at": result.get("completed_at"), "exit_code": result.get("exit_code"),
                   "diagnostics": {key: result.get(key) for key in ["error", "stderr", "stdout_truncated", "stderr_truncated"]}})
    if result.get("ok") and not result.get("stdout_truncated"):
        try:
            record["output"] = json.loads(result.get("stdout") or "null")
        except ValueError:
            record.update({"ok": False, "state": "outcome_unknown" if effects != ["read"] else "failed", "error": "CLI did not return valid JSON."})
    elif result.get("ok"):
        record.update({"ok": False, "state": "outcome_unknown" if effects != ["read"] else "failed", "incomplete": True, "error": "CLI output exceeded its bound; completeness cannot be claimed."})
    with runtime.modules.lock():
        runtime.runs.finish(record)