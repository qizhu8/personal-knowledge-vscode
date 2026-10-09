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
from pathlib import Path
from urllib.parse import unquote, urlsplit

from recipe_runtime import _atomic_write, _background_process_options
from action_modules import ModuleRuntime, process_alive


COSMOS_ACCOUNTS = {
    ("www.cosmos08.osdinfra.net", "bingads.algo.prod.adsplus"): "bingads-algo-prod-adsplus-c08",
}


def cosmos_location(uri):
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
    account = COSMOS_ACCOUNTS.get((parsed.hostname, parts[2].lower()))
    if not account:
        raise ValueError("Cosmos VC has no verified ADL account mapping.")
    remote = "/" + "/".join(parts[3:])
    if parts[3] != "shares" or any(ord(character) < 32 for character in remote) or "\\" in remote:
        raise ValueError("Invalid Cosmos share path.")
    return {"account": account, "path": posixpath.normpath(remote)}


def cosmos_command(action_id, inputs):
    location = cosmos_location(inputs["uri"])
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
        self.root = Path(store) / ".pkm" / "state" / "actions"
        self.program = program or shutil.which("az")
        self.modules = ModuleRuntime(store)

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
                 "source_id": "pkm://actions/" + action_id, "version": 1,
                 "description": definition["description"], "effect": definition["effect"],
                 "input_schema": {"type": "object", "properties": properties,
                                  "required": definition["required"], "additionalProperties": False},
                 "backend": "az-dls-fs", "implementation_hash": _digest({
                     "action_runtime": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     "recipe_runtime": hashlib.sha256(Path(__file__).with_name("recipe_runtime.py").read_bytes()).hexdigest(),
                 })}
        value["content_hash"] = _digest(value)
        return value

    def environment_fingerprint(self):
        executable = Path(self.program).resolve() if self.program else None
        return _digest({"platform": platform.system(), "architecture": platform.machine(),
                        "python": sys.version, "program": str(executable),
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
            cosmos_location(grant["remote_root"])
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
        if action_id == "cosmos.artifact.download":
            raise ValueError("Download qualification requires a separately approved round-trip fixture.")
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
            location = cosmos_location(inputs["uri"])
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
        remote = cosmos_location(inputs["uri"])
        local = Path(inputs["local_path"]).expanduser().resolve() if "local_path" in inputs else None
        policy_path = self.root / "policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8")) if policy_path.exists() else {}
        if policy.get("schema") != "pkm.action.policy/v1":
            raise PermissionError("An operator-managed Action policy is required.")
        for grant in policy.get("grants", []):
            if grant.get("action_id") != action_id:
                continue
            approved = cosmos_location(grant["remote_root"])
            if remote["account"] != approved["account"] or not _contained(remote["path"], approved["path"]):
                continue
            if local is not None:
                if not grant.get("local_root") or not local.is_relative_to(Path(grant["local_root"]).expanduser().resolve()):
                    continue
                if inputs.get("overwrite", False) and not grant.get("allow_overwrite", False):
                    continue
                if action_id.endswith("upload"):
                    if not local.exists():
                        raise ValueError("Upload source does not exist.")
                    files = [local] if local.is_file() else list(local.rglob("*"))
                    if any(item.is_symlink() for item in files):
                        raise PermissionError("Upload folders must not contain symlinks.")
                elif local.exists() and not inputs.get("overwrite", False):
                    raise FileExistsError("Download destination already exists; overwrite was not authorized.")
                inputs = {**inputs, "local_path": str(local)}
            return definition, inputs
        raise PermissionError("Action paths are outside the operator-authorized scope.")

    def call(self, action_id, inputs, idempotency_key, content_hash):
        if action_id not in DEFINITIONS:
            return self.modules.call(action_id, inputs, idempotency_key, content_hash)
        if self.availability(action_id)["state"] != "ready":
            raise PermissionError("Action is not validated for this implementation and execution environment.")
        return self._call(action_id, inputs, idempotency_key, content_hash)

    def _call(self, action_id, inputs, idempotency_key, content_hash):
        definition, inputs = self._authorize(action_id, inputs)
        if content_hash != definition["content_hash"]:
            raise ValueError("Action definition changed; retrieve and pin its current content_hash.")
        if not self.program or not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 200:
            raise ValueError("Azure CLI and an idempotency_key of 1-200 characters are required.")
        command = cosmos_command(action_id, inputs)
        fingerprint = _digest({"action_id": action_id, "inputs": inputs, "content_hash": content_hash})
        self.root.mkdir(parents=True, exist_ok=True)
        keys = self.root / "keys"
        keys.mkdir(exist_ok=True)
        key_path = keys / (_digest(idempotency_key) + ".json")
        run_id = "action_run_" + uuid.uuid4().hex
        try:
            with key_path.open("x", encoding="utf-8") as handle:
                json.dump({"run_id": run_id, "fingerprint": fingerprint}, handle)
        except FileExistsError:
            try:
                existing = json.loads(key_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                return {"ok": False, "state": "outcome_unknown", "error": "Concurrent call reservation requires reconciliation; do not retry with a new key."}
            if existing["fingerprint"] != fingerprint:
                raise ValueError("Idempotency key was already used for different inputs.")
            return self.get(existing["run_id"])
        directory = self.root / "runs" / run_id
        directory.mkdir(parents=True)
        spec = {**command, "program": self.program, "timeoutSeconds": inputs.get("timeout_seconds", 300), "maxOutputBytes": 65536}
        spec_path = directory / "spec.json"
        _atomic_write(spec_path, spec)
        record = {"schema": "pkm.action.run/v1", "ok": True, "run_id": run_id, "action_id": action_id,
                  "content_hash": content_hash, "inputs": inputs, "state": "running",
                  "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        _atomic_write(directory / "run.json", record)
        try:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", str(directory)],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       close_fds=True, **_background_process_options())
            record["launcher_pid"] = process.pid
            _atomic_write(directory / "run.json", record)
        except OSError as error:
            record.update({"ok": False, "state": "failed", "error": str(error)})
            _atomic_write(directory / "run.json", record)
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
        if result_path.exists():
            result = json.loads(result_path.read_text(encoding="utf-8"))
            uncertain = result.get("timed_out") or result.get("cancelled")
            record.update({"ok": bool(result.get("ok")), "state": "outcome_unknown" if uncertain else "succeeded" if result.get("ok") else "failed",
                           "completed_at": result.get("completed_at"), "exit_code": result.get("exit_code"),
                           "diagnostics": {key: result.get(key) for key in ["error", "stderr", "stdout_truncated", "stderr_truncated"]}})
            if result.get("ok") and not result.get("stdout_truncated"):
                try:
                    output = json.loads(result.get("stdout") or "null")
                except ValueError:
                    record.update({"ok": False, "state": "failed", "error": "CLI did not return valid JSON."})
                else:
                    record["output"] = output
            elif result.get("ok"):
                record.update({"ok": False, "state": "failed", "incomplete": True, "error": "CLI output exceeded its bound; completeness cannot be claimed."})
            _atomic_write(directory / "run.json", record)
        elif record["state"] == "running" and record.get("launcher_pid"):
            if not process_alive(record["launcher_pid"]):
                record.update({"ok": False, "state": "outcome_unknown", "error": "Worker exited without a result; reconciliation required."})
        return record

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

    def action_retrieve(task: str, limit: int = 1):
        """Find callable Actions with typed inputs; never select an ambiguous match automatically."""
        return runtime.retrieve(task, limit)

    def action_call(action_id: str, inputs: dict, idempotency_key: str, content_hash: str):
        """Invoke a pinned Action inside operator-managed path grants; return a durable run ID."""
        return runtime.call(action_id, inputs, idempotency_key, content_hash)

    def action_run_get(run_id: str):
        """Read a durable Action run; submission is not transfer verification."""
        return runtime.get(run_id)

    def action_run_cancel(run_id: str):
        """Request local invocation cancellation; remote writes are not rolled back."""
        return runtime.cancel(run_id)

    def action_capabilities():
        """Discover Action registration, qualification, nesting and artifact lifecycle; workspace selection is a machine setting."""
        return {"schema": "pkm.action.capabilities/v1", "version": "1.0.0", "registry": str(runtime.modules.registry),
                "workspace_setting": "personalKnowledge.actions.workspaceRoots", "settings": runtime.modules.settings(),
                "platform": platform.system(), "trusted_host_execution_is_sandboxed": False,
                "tools": [function.__name__ for function in tools], "builtins": [item["action_id"] for item in runtime.modules.list()],
                "basic_components": runtime.modules.components(), "enabled_platform_actions": runtime.enabled_platform_actions()}

    def action_register(definition: dict):
        """Persist a versioned module contract. Registration grants neither execution permission nor platform readiness."""
        return runtime.modules.register(definition)

    def action_get(action_id: str):
        """Read a stable Action definition and its current target-environment readiness."""
        return {**runtime.definition(action_id), "availability": runtime.availability(action_id)
                if action_id in DEFINITIONS else runtime.modules.availability(action_id)}

    def action_validate(action_id: str, content_hash: str, inputs: dict | None = None):
        """Run declared smoke examples only after operator authorization; evidence is local and environment-specific."""
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
        return runtime.modules.recover()

    def action_validation_enqueue(action_id: str, content_hash: str, priority: str = "demand", allow_effects: bool = False):
        """Queue controlled target-host qualification. Effect consent never grants operator permissions."""
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
        """Register a language-neutral graphical composition as a callable pinned Action."""
        return runtime.modules.graph_save(graph)

    tools = [action_retrieve, action_call, action_run_get, action_run_cancel, action_capabilities, action_register,
             action_get, action_validate, action_artifact_import, action_artifact_export, action_run_gc, action_run_recover,
             action_validation_enqueue, action_validation_status, action_validation_cancel, action_validation_resume,
             action_module_sets, action_module_set_load, action_module_set_import, action_module_set_export, action_module_set_remove,
             action_implementation_select, action_graph_check, action_graph_save]
    for function in tools:
        function.__annotations__["return"] = dict
        mcp.tool(annotations={"readOnlyHint": function in [action_retrieve, action_run_get, action_get, action_capabilities,
                                 action_module_sets, action_graph_check]})(function)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--worker":
        raise SystemExit("Only the managed Action worker entry is supported.")
    from recipe_runtime import _execute_command_worker

    directory = Path(sys.argv[2])
    spec_path = directory / "spec.json"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    spec["cancelPath"] = str(directory / "cancel.json")
    _atomic_write(spec_path, spec)
    _execute_command_worker(spec_path, directory / "result.json")