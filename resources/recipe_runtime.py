"""Agent-facing Recipe discovery and persisted workflow state-machine tools."""

import contextlib
import collections
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote

try:
    from recipe_health import finalize_run_health
except ModuleNotFoundError:
    import importlib.util
    _HEALTH_SPEC = importlib.util.spec_from_file_location(
        "recipe_health", Path(__file__).resolve().with_name("recipe_health.py"))
    _HEALTH_MODULE = importlib.util.module_from_spec(_HEALTH_SPEC)
    _HEALTH_SPEC.loader.exec_module(_HEALTH_MODULE)
    finalize_run_health = _HEALTH_MODULE.finalize_run_health

RECIPE_SCHEMA_VERSION = "1.6.0"
API_SCHEMA = "pkm.recipe.api/v1"
RUN_SCHEMA = "pkm.recipe.run/v1"
DEFINITION_SCHEMA = "pkm.workflow.definition/v1"
TERMINAL_NODE_STATES = {"succeeded", "failed", "skipped"}
COMMAND_NODE_KIND = "pkm.step.command/v1"
SCRIPT_NODE_KIND = "pkm.step.script/v1"
HUMAN_GATE_NODE_KIND = "pkm.gate.human/v1"
TEMPLATE = re.compile(r"\$\{inputs\.([A-Za-z][A-Za-z0-9._-]{0,127})\}")
USAGE_RECORD_LIMIT = 200
USAGE_SUMMARY_GROUP_LIMIT = 100
USAGE_SUMMARY_RUN_SCAN_LIMIT = 5000
MEASURED_TOKEN_FIELDS = (
    "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "total_tokens")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _response(**values):
    return _json({"schema": API_SCHEMA, **values})


def _fingerprint(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _protocol_payload_estimate(*values):
    payload_bytes = len(_json(values).encode("utf-8"))
    return {"estimated_tokens": (payload_bytes + 3) // 4, "method": "utf8-bytes-divided-by-4"}


def _token_bucket(value, pointer):
    if not isinstance(value, dict) or not value:
        raise ValueError("{} must be a non-empty object.".format(pointer))
    unknown = sorted(set(value) - set(MEASURED_TOKEN_FIELDS))
    if unknown:
        raise ValueError("{} contains unknown fields: {}.".format(pointer, ", ".join(unknown)))
    normalized = {}
    for key, count in value.items():
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > 10 ** 12:
            raise ValueError("{}.{} must be a non-negative integer no greater than 1000000000000."
                             .format(pointer, key))
        normalized[key] = count
    missing = [key for key in MEASURED_TOKEN_FIELDS if key not in normalized]
    if missing:
        raise ValueError("{} is missing required fields: {}.".format(pointer, ", ".join(missing)))
    if normalized["cached_input_tokens"] > normalized["input_tokens"]:
        raise ValueError("{}.cached_input_tokens cannot exceed input_tokens.".format(pointer))
    if normalized["total_tokens"] < normalized["input_tokens"] + normalized["output_tokens"]:
        raise ValueError("{}.total_tokens cannot be less than input_tokens plus output_tokens.".format(pointer))
    return normalized


def _normalize_usage(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("usage_json must be an object or null.")
    allowed = {"measured_tokens", "estimated_tokens", "unknown_model_calls",
               "provider", "model", "derived_cost"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError("usage_json contains unknown fields: {}.".format(", ".join(unknown)))
    if not value:
        raise ValueError("usage_json must not be empty.")
    normalized = {}
    if "measured_tokens" in value:
        normalized["measured_tokens"] = _token_bucket(value["measured_tokens"], "usage_json.measured_tokens")
        if "provider" not in value or "model" not in value:
            raise ValueError("usage_json.provider and usage_json.model are required with measured_tokens.")
    if "estimated_tokens" in value:
        count = value["estimated_tokens"]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > 10 ** 12:
            raise ValueError("usage_json.estimated_tokens must be a non-negative integer no greater than 1000000000000.")
        normalized["estimated_tokens"] = count
    if "unknown_model_calls" in value:
        count = value["unknown_model_calls"]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > 1000000:
            raise ValueError("usage_json.unknown_model_calls must be a non-negative integer no greater than 1000000.")
        normalized["unknown_model_calls"] = count
    for key in ("provider", "model"):
        if key in value:
            text = value[key]
            if not isinstance(text, str) or not text.strip() or len(text) > 128:
                raise ValueError("usage_json.{} must be a non-empty string no longer than 128 characters."
                                 .format(key))
            normalized[key] = text.strip()
    if "derived_cost" in value:
        cost = value["derived_cost"]
        if not isinstance(cost, dict) or set(cost) != {"amount_micros", "currency", "price_version"}:
            raise ValueError(
                "usage_json.derived_cost must contain exactly amount_micros, currency, and price_version.")
        amount = cost["amount_micros"]
        currency = cost["currency"]
        price_version = cost["price_version"]
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0 or amount > 10 ** 15:
            raise ValueError("usage_json.derived_cost.amount_micros must be a bounded non-negative integer.")
        if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("usage_json.derived_cost.currency must be a three-letter uppercase code.")
        if not isinstance(price_version, str) or not price_version.strip() or len(price_version) > 128:
            raise ValueError("usage_json.derived_cost.price_version must be a non-empty bounded string.")
        normalized["derived_cost"] = {
            "amount_micros": amount, "currency": currency, "price_version": price_version.strip()}
    if not any(key in normalized for key in ("measured_tokens", "estimated_tokens", "unknown_model_calls")):
        raise ValueError("usage_json must include measured_tokens, estimated_tokens, or unknown_model_calls.")
    return normalized


def _empty_token_totals():
    return {key: 0 for key in MEASURED_TOKEN_FIELDS}


def _usage_summary(run):
    usage = run.get("usage") or {}
    measured = {**_empty_token_totals(), **(usage.get("measuredTokens") or {})}
    estimated = int(usage.get("estimatedTokens", 0))
    protocol = usage.get("protocolPayloadEstimate") or {}
    return {
        "measured_tokens": measured,
        "measured_total_tokens": measured["total_tokens"],
        "estimated_tokens": estimated,
        "unknown_model_calls": int(usage.get("unknownModelCalls", 0)),
        "derived_cost_micros_by_currency": dict(
            sorted((usage.get("derivedCosts") or {}).items())[:32]),
        "providers": list((usage.get("providers") or [])[:32]),
        "models": list((usage.get("models") or [])[:32]),
        "protocol_payload_estimate": {
            "estimated_tokens": int(protocol.get("estimatedTokens", 0)),
            "method": "utf8-bytes-divided-by-4",
        },
        "reported_attempts": int(usage.get("reportedAttempts", 0)),
        "records_retained": len(usage.get("records") or []),
        "records_truncated": int(usage.get("recordsTruncated", 0)),
    }


def _record_usage(run, node_id, attempt, usage_value, protocol_estimate):
    usage = run.setdefault("usage", {
        "measuredTokens": {}, "estimatedTokens": 0, "unknownModelCalls": 0,
        "protocolPayloadEstimate": {"estimatedTokens": 0}, "reportedAttempts": 0,
        "measuredReports": 0, "estimatedReports": 0, "derivedCosts": {},
        "providers": [], "models": [],
        "records": [], "recordsTruncated": 0,
    })
    usage.setdefault("measuredTokens", {})
    usage.setdefault("estimatedTokens", 0)
    usage.setdefault("unknownModelCalls", 0)
    usage.setdefault("protocolPayloadEstimate", {"estimatedTokens": 0})
    usage.setdefault("reportedAttempts", 0)
    usage.setdefault("measuredReports", 0)
    usage.setdefault("estimatedReports", 0)
    usage.setdefault("derivedCosts", {})
    usage.setdefault("providers", [])
    usage.setdefault("models", [])
    usage.setdefault("records", [])
    usage.setdefault("recordsTruncated", 0)
    for key, count in (usage_value or {}).get("measured_tokens", {}).items():
        usage["measuredTokens"][key] = int(usage["measuredTokens"].get(key, 0)) + count
    usage["estimatedTokens"] += int((usage_value or {}).get("estimated_tokens", 0))
    usage["unknownModelCalls"] += int((usage_value or {}).get("unknown_model_calls", 0))
    usage["measuredReports"] += int("measured_tokens" in (usage_value or {}))
    usage["estimatedReports"] += int("estimated_tokens" in (usage_value or {}))
    if usage_value and "derived_cost" in usage_value:
        cost = usage_value["derived_cost"]
        usage["derivedCosts"][cost["currency"]] = (
            usage["derivedCosts"].get(cost["currency"], 0) + cost["amount_micros"])
    for source, target in (("provider", "providers"), ("model", "models")):
        value = (usage_value or {}).get(source)
        if value and value not in usage[target] and len(usage[target]) < 32:
            usage[target].append(value)
    usage["protocolPayloadEstimate"]["estimatedTokens"] += protocol_estimate["estimated_tokens"]
    usage["reportedAttempts"] += 1
    record = {
        "recipeRunId": run["runId"], "nodeId": node_id, "attempt": attempt,
        "measuredTokens": (usage_value or {}).get("measured_tokens", {}),
        "estimatedTokens": int((usage_value or {}).get("estimated_tokens", 0)),
        "unknownModelCalls": int((usage_value or {}).get("unknown_model_calls", 0)),
        "protocolPayloadEstimate": protocol_estimate,
    }
    for key, stored in (("provider", "provider"), ("model", "model"), ("derived_cost", "derivedCost")):
        if usage_value and key in usage_value:
            record[stored] = usage_value[key]
    usage["records"].append(record)
    if len(usage["records"]) > USAGE_RECORD_LIMIT:
        removed = len(usage["records"]) - USAGE_RECORD_LIMIT
        del usage["records"][:removed]
        usage["recordsTruncated"] += removed


def _atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(os.getpid()) + "." + uuid.uuid4().hex + ".tmp")
    with open(temporary, "x", encoding="utf-8") as handle:
        handle.write(_json(value))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _bounded_file_text(path, maximum):
    with open(path, "rb") as handle:
        value = handle.read(maximum + 1)
    truncated = len(value) > maximum
    return value[:maximum].decode("utf-8", errors="replace"), truncated


def _background_process_options():
    if os.name == "nt":
        return {"creationflags": (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
                                  | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))}
    return {"start_new_session": True}


def _hidden_process_options():
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


def _execute_command_worker(spec_path, result_path):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    stdout_path = Path(result_path).with_suffix(".stdout")
    stderr_path = Path(result_path).with_suffix(".stderr")
    result = {"started_at": started, "argv": [spec.get("program", ""), *spec.get("args", [])]}
    process = None
    try:
        if spec.get("preflightError"):
            raise RuntimeError(spec["preflightError"])
        with open(stdout_path, "wb") as stdout_handle, open(stderr_path, "wb") as stderr_handle:
            process = subprocess.Popen(
                [spec["program"], *spec["args"]], cwd=spec.get("cwd") or None,
                stdin=subprocess.DEVNULL, stdout=stdout_handle, stderr=stderr_handle,
                shell=False, **_background_process_options())
            try:
                exit_code = process.wait(timeout=spec["timeoutSeconds"])
                timed_out = False
            except subprocess.TimeoutExpired:
                timed_out = True
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, check=False,
                                   **_hidden_process_options())
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                exit_code = process.wait()
        stdout, stdout_truncated = _bounded_file_text(stdout_path, spec["maxOutputBytes"])
        stderr, stderr_truncated = _bounded_file_text(stderr_path, spec["maxOutputBytes"])
        result.update({"ok": exit_code == 0 and not timed_out, "exit_code": exit_code,
                       "timed_out": timed_out, "stdout": stdout, "stderr": stderr,
                       "stdout_truncated": stdout_truncated, "stderr_truncated": stderr_truncated})
        if timed_out:
            result["error"] = "Command exceeded its configured timeout."
        elif exit_code != 0:
            result["error"] = "Command exited with a non-zero status."
    except Exception as error:
        result.update({"ok": False, "exit_code": None, "timed_out": False,
                       "stdout": "", "stderr": "", "stdout_truncated": False,
                       "stderr_truncated": False, "error": str(error)})
    finally:
        result["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _atomic_write(Path(result_path), result)
        stdout_path.unlink(missing_ok=True)
        stderr_path.unlink(missing_ok=True)
        if spec.get("cleanupPath"):
            Path(spec["cleanupPath"]).unlink(missing_ok=True)


def _input_value(inputs, path):
    value = inputs
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise ValueError("Recipe command references missing input: " + path)
        value = value[part]
    if isinstance(value, (dict, list)):
        return _json(value)
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _render_template(value, inputs):
    return TEMPLATE.sub(lambda match: _input_value(inputs, match.group(1)), value)


def _normalize_typed_value(descriptor, value, pointer):
    value_type = descriptor.get("type")
    nullable = descriptor.get("nullable") is True
    if value is None:
        if value_type == "null" or nullable:
            return None
        raise ValueError("{} cannot be null.".format(pointer))
    if value_type == "null":
        raise ValueError("{} must be null.".format(pointer))
    if value_type == "string":
        if not isinstance(value, str):
            raise ValueError("{} must be a string.".format(pointer))
        return value
    if value_type == "boolean":
        if not isinstance(value, bool):
            raise ValueError("{} must be a boolean.".format(pointer))
        return value
    if value_type == "int64":
        if not isinstance(value, str) or not re.fullmatch(r"(0|-[1-9][0-9]*|[1-9][0-9]*)", value):
            raise ValueError("{} must use the canonical int64 string form.".format(pointer))
        parsed = int(value)
        if parsed < -9223372036854775808 or parsed > 9223372036854775807:
            raise ValueError("{} is outside the signed int64 range.".format(pointer))
        return value
    if value_type == "decimal":
        if not isinstance(value, str) or not re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", value):
            raise ValueError("{} must use the canonical decimal string form.".format(pointer))
        negative = value.startswith("-")
        unsigned = value[1:] if negative else value
        integer, _, fraction = unsigned.partition(".")
        fraction = fraction.rstrip("0")
        normalized = integer + (("." + fraction) if fraction else "")
        return "0" if normalized == "0" else (("-" + normalized) if negative else normalized)
    if value_type in {"artifact", "secret-handle"}:
        if not isinstance(value, dict):
            raise ValueError("{} must be a reference object.".format(pointer))
        keys = ["evidenceId", "digest"] if value_type == "artifact" else ["secretId", "versionId"]
        if set(value) != set(keys) or any(not isinstance(value.get(key), str) or not value[key]
                                          for key in keys):
            raise ValueError("{} is not a valid {} reference.".format(pointer, value_type))
        return {key: value[key] for key in keys}
    schema = descriptor.get("schema") or {}
    if value_type == "array":
        if not isinstance(value, list):
            raise ValueError("{} must be an array.".format(pointer))
        minimum = schema.get("minItems")
        maximum = schema.get("maxItems")
        if isinstance(minimum, int) and len(value) < minimum:
            raise ValueError("{} has fewer items than allowed.".format(pointer))
        if isinstance(maximum, int) and len(value) > maximum:
            raise ValueError("{} has more items than allowed.".format(pointer))
        return [_normalize_typed_value(schema["items"], item, "{}/{}".format(pointer, index))
                for index, item in enumerate(value)]
    if value_type == "object":
        if not isinstance(value, dict):
            raise ValueError("{} must be an object.".format(pointer))
        return _normalize_typed_inputs(schema.get("properties") or {}, value, pointer, strict=True)
    raise ValueError("{} uses an unsupported workflow value type.".format(pointer))


def _normalize_typed_inputs(descriptors, inputs, pointer="/inputs", strict=False):
    if not isinstance(inputs, dict):
        raise ValueError("{} must be an object.".format(pointer))
    if not descriptors:
        return dict(inputs)
    if strict:
        unknown = sorted(set(inputs) - set(descriptors))
        if unknown:
            raise ValueError("{} contains unknown fields: {}.".format(pointer, ", ".join(unknown)))
    normalized = {}
    for name, descriptor in descriptors.items():
        if name in inputs:
            normalized[name] = _normalize_typed_value(descriptor, inputs[name], "{}/{}".format(pointer, name))
        elif "default" in descriptor:
            normalized[name] = _normalize_typed_value(descriptor, descriptor["default"], "{}/{}".format(pointer, name))
        elif descriptor.get("required") is True:
            raise ValueError("{}/{} is required.".format(pointer, name))
    if not strict:
        normalized.update({name: value for name, value in inputs.items() if name not in normalized})
    return normalized


def _normalize_run_inputs(definition, inputs):
    descriptors = definition.get("spec", {}).get("inputs") or {}
    return _normalize_typed_inputs(descriptors, inputs, strict=bool(descriptors))


@contextlib.contextmanager
def _file_lock(path, timeout=5.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, _json({"pid": os.getpid(), "createdAt": time.time()}).encode("utf-8"))
            os.close(descriptor)
            break
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
                if age > 30:
                    path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise RuntimeError("recipe runtime lock timeout")
            time.sleep(0.025)
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def _parse_json(value, label, expected_type=dict):
    try:
        parsed = json.loads(value or ("{}" if expected_type is dict else "null"))
    except json.JSONDecodeError as error:
        raise ValueError(label + " must be valid JSON: " + str(error)) from error
    if expected_type is not None and not isinstance(parsed, expected_type):
        raise ValueError(label + " must decode to " + expected_type.__name__)
    return parsed


def _project_recipes(store):
    root = store / "recipes"
    control = store / ".pkm" / "state" / "recipe-store.json"
    if root.exists() and control.exists():
        candidates = []
        for path in sorted(root.rglob("*.json")):
            relative = path.relative_to(root)
            if ".trash" in relative.parts:
                continue
            try:
                recipe = json.loads(path.read_text(encoding="utf-8"))
                _validate_definition(recipe)
                recipe_id = str(recipe.get("recipeId") or "")
                knowledge_id = str(recipe.get("knowledgeId") or "")
                category = "" if relative.parent.as_posix() == "Uncategorized" else relative.parent.as_posix()
                if (not recipe_id or not re.fullmatch(r"knowledge_[a-f0-9]{24}", knowledge_id)
                        or recipe.get("schema") != "pkm.knowledge/v1"
                        or not isinstance(recipe.get("revision"), int) or recipe.get("revision") < 1
                        or not isinstance(recipe.get("aliases"), list)
                        or recipe.get("executableDigest") != _fingerprint(recipe.get("definition") or {})
                        or str(recipe.get("category") or "") != category
                        or not path.name.endswith("." + recipe_id + ".json")):
                    continue
                candidates.append(recipe)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
        id_counts = collections.Counter(item["recipeId"] for item in candidates)
        knowledge_counts = collections.Counter(item["knowledgeId"] for item in candidates)
        return [item for item in candidates
                if id_counts[item["recipeId"]] == 1 and knowledge_counts[item["knowledgeId"]] == 1]
    path = store / ".pkm" / "state" / "projects.json"
    if not path.exists():
        return []
    envelope = json.loads(path.read_text(encoding="utf-8"))
    payload = envelope.get("payload")
    if not isinstance(payload, dict) or _fingerprint(payload) != envelope.get("digest"):
        raise ValueError("Project store digest is invalid.")
    recipes = (payload.get("state") or {}).get("recipes") or []
    if not isinstance(recipes, list):
        raise ValueError("Project store Recipes are invalid.")
    return recipes


def _project_store_paths(store):
    directory = store / ".pkm" / "state"
    return directory / "projects.json", directory / "projects.lock"


def _load_project_envelope(store):
    path, _ = _project_store_paths(store)
    envelope = json.loads(path.read_text(encoding="utf-8"))
    payload = envelope.get("payload")
    if (envelope.get("schema") != 1 or not isinstance(envelope.get("storeVersion"), int)
            or not isinstance(payload, dict) or _fingerprint(payload) != envelope.get("digest")):
        raise ValueError("Project store envelope is invalid.")
    state = payload.get("state")
    receipts = payload.get("receipts")
    if not isinstance(state, dict) or not isinstance(receipts, list):
        raise ValueError("Project store payload is invalid.")
    return path, envelope


def _author_recipe_from_skill(store, name, description, category, definition, command_id,
                              source_skill_id, source_skill_hash, scope="global", project_id=""):
    if not all(str(value or "").strip() for value in [name, command_id, source_skill_id]):
        raise ValueError("name, command_id, and source_skill_id are required.")
    if not isinstance(source_skill_hash, str) or len(source_skill_hash) != 64:
        raise ValueError("source_skill_hash must be a SHA-256 content hash.")
    if scope not in {"global", "project"}:
        raise ValueError("scope must be global or project.")
    executable_digest = _fingerprint(definition)
    first_node = (((definition or {}).get("spec") or {}).get("nodes") or [{}])[0].get("nodeId")
    recipe_id = "recipe_" + hashlib.sha256(("skill-recipe\0" + command_id).encode("utf-8")).hexdigest()[:32]
    binding = {"bindingId": "source-skill", "kind": "skill", "knowledgeId": source_skill_id,
               "contentHash": source_skill_hash, "usage": "required"}
    recipe = {"recipeId": recipe_id, "scope": "global", "category": _portable_recipe_category(category),
              "name": str(name).strip(), "description": str(description or "").strip(),
              "metadata": {"applicableFunctions": [], "solution": str(description or "").strip(),
                           "requiredInputs": [], "expectedOutputs": []},
              "definition": definition, "nodeBindings": [{"nodeId": first_node, "bindings": [binding]}],
              "executableDigest": executable_digest, "revision": 1,
              "origin": {"kind": "skill-recipe-gap", "skillId": source_skill_id}}
    fingerprint = _fingerprint({"name": recipe["name"], "description": recipe["description"],
                                "category": recipe["category"], "definition": definition,
                                "scope": scope, "project_id": project_id,
                                "source_skill_id": source_skill_id, "source_skill_hash": source_skill_hash})
    _validate_definition(recipe)
    canonical_store = ((store / "recipes").exists()
                       and (store / ".pkm" / "state" / "recipe-store.json").exists())
    if not canonical_store:
        legacy_recipe = dict(recipe)
        legacy_recipe["scope"] = scope
        if scope == "project":
            legacy_recipe["projectId"] = project_id
        return _author_legacy_recipe(store, legacy_recipe, command_id, fingerprint, project_id)
    if scope == "project":
        if not str(project_id or "").strip():
            raise ValueError("project_id is required for a Project Recipe.")
        _, project_envelope = _load_project_envelope(store)
        project = next((item for item in project_envelope["payload"]["state"].get("projects") or []
                        if item.get("projectId") == project_id), None)
        if not project:
            raise ValueError("Project Recipe references an unknown Project.")
        recipe["category"] = "/".join(part for part in [
            "Project", _safe_recipe_category_segment(project.get("name")),
            _portable_recipe_category(category)
        ] if part)
    relative = (recipe["category"] or "Uncategorized") + "/" + _safe_recipe_name(recipe["name"]) + "." + recipe_id + ".json"
    recipe["schema"] = "pkm.knowledge/v1"
    recipe["knowledgeId"] = "knowledge_" + hashlib.sha256(("recipe\0" + recipe_id).encode("utf-8")).hexdigest()[:24]
    recipe["aliases"] = sorted({"recipe:" + recipe_id, "recipe:" + relative})
    path = store / "recipes" / relative
    lock = store / ".pkm" / "state" / "recipes.lock"
    with _file_lock(lock):
        existing = next((item for item in _project_recipes(store) if item.get("recipeId") == recipe_id), None)
        if existing:
            comparable = dict(existing)
            for field in ["schema", "knowledgeId", "aliases"]:
                comparable.pop(field, None)
            authored = dict(recipe)
            for field in ["schema", "knowledgeId", "aliases"]:
                authored.pop(field, None)
            if _fingerprint(comparable) != _fingerprint(authored):
                raise ValueError("command_id was reused with different parameters.")
            return existing, True
        if any(item.get("recipeId") == recipe_id for item in _project_recipes(store)):
            raise ValueError("Generated Recipe identity already exists.")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + str(os.getpid()) + "." + uuid.uuid4().hex + ".tmp")
        with open(temporary, "x", encoding="utf-8") as handle:
            json.dump(recipe, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        control = store / ".pkm" / "state" / "recipe-store.json"
        if not control.exists():
            _atomic_write(control, {"schema": 1})
        return recipe, False


def _author_legacy_recipe(store, recipe, command_id, fingerprint, project_id):
    path, lock = _project_store_paths(store)
    with _file_lock(lock):
        path, envelope = _load_project_envelope(store)
        payload = envelope["payload"]
        for receipt in payload["receipts"]:
            if receipt.get("commandId") != command_id:
                continue
            if receipt.get("fingerprint") != fingerprint:
                raise ValueError("command_id was reused with different parameters.")
            existing = next((item for item in (payload["state"].get("recipes") or [])
                             if item.get("recipeId") == receipt.get("entityId")), None)
            if not existing:
                raise ValueError("Idempotent Recipe receipt references a missing Recipe.")
            return existing, True
        if recipe["scope"] == "project" and not any(
                project.get("projectId") == project_id
                for project in payload["state"].get("projects") or []):
            raise ValueError("Project Recipe references an unknown Project.")
        recipes = payload["state"].setdefault("recipes", [])
        if any(item.get("recipeId") == recipe["recipeId"] for item in recipes):
            raise ValueError("Generated Recipe identity already exists.")
        recipes.append(recipe)
        store_version = envelope["storeVersion"] + 1
        payload["receipts"].append({
            "commandId": command_id, "fingerprint": fingerprint,
            "operation": "recipe-create-from-skill", "storeVersion": store_version,
            "entityId": recipe["recipeId"],
        })
        _atomic_write(path, {
            "schema": 1, "storeVersion": store_version, "payload": payload,
            "digest": _fingerprint(payload),
        })
        return recipe, False


def _safe_recipe_name(value):
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]+', "-", str(value or "").strip())
    safe = re.sub(r"\s+", "-", safe).strip(" .-") or "Recipe"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", safe, re.IGNORECASE):
        safe += "-Recipe"
    return safe[:120].rstrip(" .") or "Recipe"


def _safe_recipe_category_segment(value):
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]+', "-", str(value or "").strip())
    safe = safe.strip(" .") or "Project"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", safe, re.IGNORECASE):
        safe += "-Project"
    return safe[:120].rstrip(" .") or "Project"


def _portable_recipe_category(value):
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    parts = raw.split("/")
    if (raw.startswith("/") or raw.endswith("/") or "//" in raw
            or any(not part or part in {".", "..", ".trash", "Uncategorized"}
                   or re.search(r'[<>:"\\|?*\x00-\x1f\x7f]', part)
                   or part.endswith((" ", ".")) for part in parts)):
        raise ValueError("Recipe category is not a portable relative path.")
    if parts == ["Project"]:
        raise ValueError("Recipes under Project require a Project subcategory.")
    return "/".join(parts)


def _recipe_by_id(store, recipe_id, project_id=""):
    for recipe in _project_recipes(store):
        if recipe.get("recipeId") != recipe_id:
            continue
        if recipe.get("scope") == "global" or recipe.get("projectId") == project_id:
            return recipe
    raise ValueError("Recipe is not accessible in the requested Project scope.")


def _recipe_summary(recipe, score=0):
    nodes = ((recipe.get("definition") or {}).get("spec") or {}).get("nodes") or []
    metadata = recipe.get("metadata") or {}
    methodology = recipe.get("methodology") or {}
    return {
        "recipe_id": recipe.get("recipeId"),
        "name": recipe.get("name"),
        "description": recipe.get("description") or "",
        "category": recipe.get("category") or "",
        "metadata": {
            "applicable_functions": metadata.get("applicableFunctions") or [],
            "solution": metadata.get("solution") or "",
            "required_inputs": metadata.get("requiredInputs") or [],
            "expected_outputs": metadata.get("expectedOutputs") or [],
        },
        "scope": recipe.get("scope"),
        "project_id": recipe.get("projectId"),
        "revision": recipe.get("revision"),
        "executable_digest": recipe.get("executableDigest"),
        "methodology": ({
            "family": methodology.get("family"),
            "phase": methodology.get("phase"),
            "abstract": bool(methodology.get("abstract")),
            "capabilities": methodology.get("capabilities") or [],
            "artifacts": methodology.get("artifacts") or {"inputs": [], "outputs": []},
            "gates": methodology.get("gates") or [],
            "invariants": methodology.get("invariants") or [],
            "communication": methodology.get("communication") or {},
            "retrieval": methodology.get("retrieval") or {},
            "digest": recipe.get("methodologyDigest"),
        } if methodology else None),
        "node_count": len(nodes),
        "score": score,
    }


def related_recipes(store, knowledge_id, kind):
    """Derive reverse Recipe links from canonical node knowledge bindings."""
    if kind not in {"skill", "note"}:
        raise ValueError("Recipe knowledge link kind must be skill or note.")
    wanted = str(knowledge_id or "").strip("/").casefold()
    if not wanted:
        return []
    related = []
    for recipe in _project_recipes(Path(store)):
        matches = []
        for entry in recipe.get("nodeBindings") or []:
            if not isinstance(entry, dict):
                continue
            for binding in entry.get("bindings") or []:
                if (isinstance(binding, dict) and binding.get("kind") == kind
                        and str(binding.get("knowledgeId") or "").strip("/").casefold() == wanted):
                    matches.append({"node_id": entry.get("nodeId"), "usage": binding.get("usage")})
        if matches:
            summary = _recipe_summary(recipe)
            summary["bindings"] = matches
            related.append(summary)
    related.sort(key=lambda item: (item.get("name") or "", item.get("recipe_id") or ""))
    return related


def _subscribed_recipes(subscription_cache):
    root = Path(subscription_cache) if subscription_cache else None
    if root is None or not root.exists():
        return []
    recipes = []
    for metadata_path in root.glob("*/*/_subscription.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        content_root = metadata_path.parent / "content" / "recipes"
        if not content_root.exists():
            continue
        for recipe_path in content_root.rglob("*.json"):
            if recipe_path.name.endswith(".pkm-source.json"):
                continue
            try:
                recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
                _validate_definition(recipe)
                if recipe.get("executableDigest") != _fingerprint(recipe.get("definition") or {}):
                    continue
            except (json.JSONDecodeError, OSError, ValueError):
                continue
            relative = recipe_path.relative_to(content_root).as_posix()
            node_id = str(metadata.get("nodeId") or metadata_path.parents[1].name)
            share_id = str(metadata.get("shareId") or metadata_path.parent.name)
            recipe["_subscription"] = {
                "pkmPath": "pkm://subscriptions/{}/{}/recipes/{}".format(
                    quote(node_id, safe=""), quote(share_id, safe=""),
                    "/".join(quote(part, safe="") for part in relative.split("/"))),
                "subscriptionId": metadata.get("subscriptionId"),
                "alias": metadata.get("alias"),
                "brokerName": metadata.get("brokerName"),
                "publisher": metadata.get("publisher"),
                "nodeId": node_id,
                "shareId": share_id,
                "revision": metadata.get("revision"),
            }
            recipes.append(recipe)
    return recipes


def _search(store, query, category, project_id, limit, task_contract, subscription_cache=None):
    terms = [term for term in str(query or "").lower().split() if term]
    category_lower = str(category or "").strip().lower()
    candidates = []
    available = [(recipe, False) for recipe in _project_recipes(store)]
    available.extend((recipe, True) for recipe in _subscribed_recipes(subscription_cache))
    for recipe, subscribed in available:
        if not subscribed and recipe.get("scope") != "global" and recipe.get("projectId") != project_id:
            continue
        recipe_category = str(recipe.get("category") or "")
        if category_lower and not recipe_category.lower().startswith(category_lower):
            continue
        nodes = ((recipe.get("definition") or {}).get("spec") or {}).get("nodes") or []
        metadata = recipe.get("metadata") or {}
        methodology = recipe.get("methodology") or {}
        methodology_artifacts = methodology.get("artifacts") or {}
        methodology_retrieval = methodology.get("retrieval") or {}
        methodology_communication = methodology.get("communication") or {}
        metadata_fields = [*(metadata.get("requiredInputs") or []), *(metadata.get("expectedOutputs") or [])]
        text = "\n".join(str(value or "") for value in [
            recipe.get("name"), recipe.get("description"), recipe_category,
            *(metadata.get("applicableFunctions") or []), metadata.get("solution"),
            *[field.get("name") for field in metadata_fields if isinstance(field, dict)],
            *[field.get("description") for field in metadata_fields if isinstance(field, dict)],
            *[node.get("nodeId") for node in nodes if isinstance(node, dict)],
            *[node.get("kind") for node in nodes if isinstance(node, dict)],
            methodology.get("family"), methodology.get("phase"),
            *(methodology.get("capabilities") or []),
            *(methodology_artifacts.get("inputs") or []),
            *(methodology_artifacts.get("outputs") or []),
            *(methodology.get("gates") or []),
            *(methodology.get("invariants") or []),
            methodology_communication.get("minimumAssurance"),
            *(methodology_communication.get("escalateOn") or []),
            *(methodology_retrieval.get("intents") or []),
            *(methodology_retrieval.get("terminology") or []),
            *(methodology_retrieval.get("operationalPoints") or []),
        ]).lower()
        if terms and not all(term in text for term in terms):
            continue
        name = str(recipe.get("name") or "").lower()
        score = (40 if category_lower and recipe_category.lower() == category_lower else 20 if category_lower else 0)
        score += 30 if query and str(query).lower() == name else 10 * sum(term in name for term in terms)
        score += 5 * sum(term in text for term in terms)
        summary = _recipe_summary(recipe, score)
        if subscribed:
            provenance = recipe["_subscription"]
            summary.update({"source": "subscription", "read_only": True, "requires_fork": True,
                            "original_recipe_id": summary["recipe_id"], "pkm_path": provenance["pkmPath"],
                            "provenance": provenance})
        candidates.append(summary)
    candidates.sort(key=lambda item: (-item["score"], item["name"] or "", item["recipe_id"] or ""))
    candidates = candidates[:max(1, min(int(limit or 10), 50))]
    if candidates:
        local_ids = [item["recipe_id"] for item in candidates if not item.get("read_only")]
        subscribed_paths = [item["pkm_path"] for item in candidates if item.get("read_only")]
        next_action = ({"kind": "qualify_recipe", "candidate_recipe_ids": local_ids,
                        "read_only_recipe_paths": subscribed_paths, "task_contract": task_contract}
                       if local_ids else
                       {"kind": "review_subscribed_recipe", "pkm_paths": subscribed_paths,
                        "instruction": "Read and explicitly fork or import the subscribed Recipe before execution.",
                        "task_contract": task_contract})
        return _response(ok=True, outcome="candidates", qualification="metadata-only-v1",
                         candidates=candidates,
                         next_action=next_action)
    requested_family = str(
        task_contract.get("methodologyFamily") or task_contract.get("family") or ""
    ).strip().lower() if isinstance(task_contract, dict) else ""
    local_available = [
        recipe for recipe, subscribed in available
        if not subscribed
        and (recipe.get("scope") == "global" or recipe.get("projectId") == project_id)
        and not (recipe.get("methodology") or {}).get("abstract")
    ]
    fallback_kind = ""
    fallback_recipes = []
    if requested_family:
        fallback_recipes = [
            recipe for recipe in local_available
            if str((recipe.get("methodology") or {}).get("family") or "").lower() == requested_family
        ]
        fallback_kind = "family-fallback" if fallback_recipes else ""
    if not fallback_recipes:
        fallback_recipes = [
            recipe for recipe in local_available
            if (recipe.get("methodology") or {}).get("family") == "universal-unknown-task"
        ]
        fallback_kind = "universal-fallback" if fallback_recipes else ""
    if fallback_recipes:
        fallback_candidates = [_recipe_summary(recipe, 0) for recipe in fallback_recipes]
        fallback_candidates.sort(key=lambda item: (item["name"] or "", item["recipe_id"] or ""))
        fallback_candidates = fallback_candidates[:max(1, min(int(limit or 10), 50))]
        return _response(
            ok=True,
            outcome=fallback_kind,
            qualification="methodology-fallback-v1",
            candidates=fallback_candidates,
            next_action={
                "kind": "qualify_recipe",
                "candidate_recipe_ids": [item["recipe_id"] for item in fallback_candidates],
                "task_contract": task_contract,
                "fallback": fallback_kind,
                "reason": (
                    "No exact metadata match; selected the requested Methodology family."
                    if fallback_kind == "family-fallback"
                    else "No exact or family match; selected the universal unknown-task fallback."
                ),
            },
        )
    return _response(ok=True, outcome="no-match", qualification="metadata-only-v1", candidates=[],
                     next_action={"kind": "design_recipe", "task_contract": task_contract,
                                  "reason": "No accessible metadata candidate matched. Recipe persistence requires the extension authoring bridge."})


def _validate_definition(recipe):
    definition = recipe.get("definition") or {}
    if definition.get("schema") != DEFINITION_SCHEMA:
        raise ValueError("Only pkm.workflow.definition/v1 Recipes can run lazily.")
    spec = definition.get("spec") or {}
    nodes = spec.get("nodes") or []
    if not nodes:
        raise ValueError("Recipe has no nodes.")
    node_ids = {node.get("nodeId") for node in nodes if isinstance(node, dict)}
    if len(node_ids) != len(nodes) or None in node_ids:
        raise ValueError("Recipe node identities are invalid.")
    for node in nodes:
        if node.get("kind") not in {"pkm.step.noop/v1", COMMAND_NODE_KIND, SCRIPT_NODE_KIND, HUMAN_GATE_NODE_KIND,
                                    "pkm.subflow/v1"} or not isinstance(node.get("dependsOn"), list):
            raise ValueError("Recipe contains an unsupported v1 node.")
        if any(dependency.get("from") not in node_ids for dependency in node["dependsOn"]):
            raise ValueError("Recipe dependency references an unknown node.")
        if node.get("kind") == "pkm.subflow/v1":
            config = node.get("config") or {}
            digest = config.get("executableDigest")
            if (not config.get("recipeId") or not isinstance(config.get("revision"), int)
                    or isinstance(config.get("revision"), bool) or config["revision"] < 1
                    or not isinstance(digest, str) or len(digest) != 64
                    or any(character not in "0123456789abcdef" for character in digest)):
                raise ValueError("Recipe subflow must pin an exact Recipe revision and SHA-256 digest.")
        if node.get("kind") == COMMAND_NODE_KIND:
            config = node.get("config") or {}
            if (not isinstance(config.get("program"), str) or not config["program"].strip()
                    or any(character in config["program"] for character in "\r\n\0")
                    or not isinstance(config.get("args"), list)
                    or any(not isinstance(argument, str) or "\0" in argument for argument in config["args"])):
                raise ValueError("Recipe command must use a program and an argv string list.")
            timeout = config.get("timeoutSeconds", 300)
            maximum = config.get("maxOutputBytes", 65536)
            if (not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 3600
                    or not isinstance(maximum, int) or isinstance(maximum, bool)
                    or maximum < 1024 or maximum > 1048576):
                raise ValueError("Recipe command timeout or output limit is invalid.")
            if config.get("cwd") is not None and (not isinstance(config["cwd"], str)
                                                   or not config["cwd"].strip()
                                                   or any(character in config["cwd"] for character in "\r\n\0")):
                raise ValueError("Recipe command cwd is invalid.")
        if node.get("kind") == SCRIPT_NODE_KIND:
            config = node.get("config") or {}
            runtime = config.get("runtime")
            script = config.get("script")
            environment_id = config.get("environmentId")
            if runtime not in {"bash", "powershell", "python"}:
                raise ValueError("Recipe script runtime is invalid.")
            if not isinstance(script, str) or not script.strip() or "\0" in script:
                raise ValueError("Recipe script content is required and cannot contain null characters.")
            if runtime == "python" and (not isinstance(environment_id, str) or not environment_id.strip()):
                raise ValueError("Recipe Python script requires a PKM environmentId.")
            if runtime != "python" and environment_id is not None:
                raise ValueError("Recipe environmentId is only valid for Python scripts.")
            timeout = config.get("timeoutSeconds", 300)
            maximum = config.get("maxOutputBytes", 65536)
            if (not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 3600
                    or not isinstance(maximum, int) or isinstance(maximum, bool)
                    or maximum < 1024 or maximum > 1048576):
                raise ValueError("Recipe script timeout or output limit is invalid.")
            if config.get("cwd") is not None and (not isinstance(config["cwd"], str)
                                                   or not config["cwd"].strip()
                                                   or any(character in config["cwd"] for character in "\r\n\0")):
                raise ValueError("Recipe script cwd is invalid.")
        if node.get("kind") == HUMAN_GATE_NODE_KIND:
            config = node.get("config") or {}
            input_kind = config.get("inputKind")
            choices = config.get("choices")
            if not isinstance(config.get("prompt"), str) or not config["prompt"].strip():
                raise ValueError("Recipe human gate prompt is required.")
            if input_kind not in {"approval", "text", "choice"}:
                raise ValueError("Recipe human gate inputKind is invalid.")
            if input_kind == "choice" and (not isinstance(choices, list) or len(choices) < 2
                                             or any(not isinstance(choice, str) or not choice.strip() for choice in choices)
                                             or len(set(choices)) != len(choices)):
                raise ValueError("Recipe human gate choices are invalid.")
            if input_kind != "choice" and choices is not None:
                raise ValueError("Recipe human gate choices are only valid for choice input.")
    nodes_by_id = {node["nodeId"]: node for node in nodes}
    for node in nodes:
        for dependency in node["dependsOn"]:
            accepted = dependency.get("accept", ["succeeded"])
            if (not isinstance(accepted, list) or not accepted
                    or any(not isinstance(outcome, str) or not outcome for outcome in accepted)):
                raise ValueError("Recipe dependency accept must be a non-empty outcome list.")
            source = nodes_by_id[dependency["from"]]
            possible = {*_accepted_outcomes(source), "skipped"}
            impossible = sorted(set(accepted) - possible)
            if impossible:
                raise ValueError(
                    f"Recipe dependency {source['nodeId']} -> {node['nodeId']} cannot emit accepted outcome(s): "
                    f"{', '.join(impossible)}. Allowed outcomes: {', '.join(sorted(possible))}."
                )
    bindings = {}
    for entry in recipe.get("nodeBindings") or []:
        node_id = entry.get("nodeId") if isinstance(entry, dict) else None
        if node_id not in node_ids or node_id in bindings or not isinstance(entry.get("bindings"), list):
            raise ValueError("Recipe knowledge bindings reference an invalid or duplicate node.")
        node_bindings = []
        binding_ids = set()
        for binding in entry["bindings"]:
            if (not isinstance(binding, dict) or not binding.get("bindingId") or binding.get("bindingId") in binding_ids
                    or binding.get("kind") not in {"skill", "note"} or not binding.get("knowledgeId")
                    or binding.get("usage") not in {"required", "recommended", "reference"}
                    or not isinstance(binding.get("contentHash"), str) or len(binding["contentHash"]) != 64):
                raise ValueError("Recipe knowledge binding is invalid or duplicated.")
            binding_ids.add(binding["bindingId"])
            node_bindings.append(binding)
        bindings[node_id] = node_bindings
    return definition, bindings


def _loop_edges(definition):
    edges = []
    for target in definition["spec"]["nodes"]:
        for dependency in target.get("dependsOn", []):
            if dependency.get("loop"):
                termination = dependency["loop"].get("termination") or {}
                maximum = termination.get("maxIterations")
                if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
                    raise ValueError("Recipe loop maxIterations must be a positive integer.")
                if not str(termination.get("condition") or "").strip():
                    raise ValueError("Recipe loop termination condition is required.")
                edges.append({"loopId": dependency["from"] + "->" + target["nodeId"],
                              "source": dependency["from"], "target": target["nodeId"],
                              "accept": dependency.get("accept", ["succeeded"]),
                              "condition": termination["condition"], "maxIterations": maximum})
    return edges


def _loop_body_ids(definition, edge):
    forward = {}
    reverse = {}
    for node in definition["spec"]["nodes"]:
        forward.setdefault(node["nodeId"], set())
        reverse.setdefault(node["nodeId"], set())
        for dependency in node.get("dependsOn", []):
            if dependency.get("loop"):
                continue
            forward.setdefault(dependency["from"], set()).add(node["nodeId"])
            reverse.setdefault(node["nodeId"], set()).add(dependency["from"])

    def reachable(graph, start):
        found = {start}
        pending = [start]
        while pending:
            for node_id in graph.get(pending.pop(), set()):
                if node_id not in found:
                    found.add(node_id)
                    pending.append(node_id)
        return found

    body = reachable(forward, edge["target"]) & reachable(reverse, edge["source"])
    if edge["source"] not in body or edge["target"] not in body:
        raise ValueError("Recipe loop back-edge does not close a forward execution path.")
    return [node["nodeId"] for node in definition["spec"]["nodes"] if node["nodeId"] in body]


def _initialize_loops(definition):
    loops = {}
    for edge in _loop_edges(definition):
        loops[edge["loopId"]] = {**edge, "body": _loop_body_ids(definition, edge),
                                  "iteration": 1, "history": [], "state": "running"}
    return loops


def _loop_context(run, node_id):
    contexts = []
    for loop in run.get("loops", {}).values():
        if node_id in loop["body"]:
            contexts.append({key: loop[key] for key in ["loopId", "iteration", "maxIterations", "condition"]})
    return contexts


def _apply_loop_outcome(run, node_id, outcome):
    for loop in run.get("loops", {}).values():
        if loop["source"] != node_id:
            continue
        snapshot = {body_id: dict(run["nodes"][body_id]) for body_id in loop["body"]}
        loop["history"].append({"iteration": loop["iteration"], "nodes": snapshot})
        if outcome not in loop["accept"]:
            loop["state"] = "failed" if outcome == "failed" else "completed"
            continue
        if loop["iteration"] >= loop["maxIterations"]:
            loop["state"] = "limited"
            record = run["nodes"][node_id]
            record.update({"state": "failed", "outcome": "failed",
                           "error": "Loop reached maxIterations before its termination condition."})
            run["status"] = "failed"
            return {"kind": "none", "reason": "loop-limit-reached", "loop_id": loop["loopId"],
                    "iteration": loop["iteration"], "max_iterations": loop["maxIterations"]}
        loop["iteration"] += 1
        for body_id in loop["body"]:
            run["nodes"][body_id] = {"state": "pending"}
    return None


def _run_paths(store, run_id):
    if not run_id.startswith("recipe_run_") or not all(character.isalnum() or character in "_-" for character in run_id):
        raise ValueError("Invalid Recipe run identity.")
    directory = store / ".pkm" / "state" / "recipe-runs"
    return directory / (run_id + ".json"), directory / (run_id + ".lock")


def _new_run(recipe, definition, node_bindings, inputs, run_id, project_id="", ancestry=None, parent=None):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    inputs = _normalize_run_inputs(definition, inputs)
    return {"schema": RUN_SCHEMA, "runId": run_id, "status": "running", "version": 1,
            "recipeId": recipe["recipeId"], "recipeRevision": recipe.get("revision"),
            "executableDigest": recipe.get("executableDigest"), "projectId": project_id,
            "recipeName": str(recipe.get("name") or recipe["recipeId"]),
            "origin": recipe.get("origin") or {"kind": "library"},
            "definition": definition, "nodeBindings": node_bindings, "inputs": inputs,
            "nodes": {node["nodeId"]: {"state": "pending"} for node in definition["spec"]["nodes"]},
            "nodeAttemptCounts": {},
            "loops": _initialize_loops(definition), "ancestry": list(ancestry or [recipe["recipeId"]]),
            **({"parent": parent} if parent else {}),
            **({"healthPolicy": recipe["healthPolicy"]} if isinstance(recipe.get("healthPolicy"), dict) else {}),
            **({"healthContext": recipe["healthContext"]} if isinstance(recipe.get("healthContext"), dict) else {}),
            "receipts": {}, "createdAt": now, "updatedAt": now}


def _load_run(path):
    if not path.exists():
        raise ValueError("Recipe run was not found.")
    run = json.loads(path.read_text(encoding="utf-8"))
    if run.get("schema") != RUN_SCHEMA:
        raise ValueError("Recipe run schema is unsupported.")
    return run


def _bind_subflow(store, run, node):
    record = run["nodes"][node["nodeId"]]
    if record.get("childRunId"):
        return False
    config = node["config"]
    try:
        child_recipe = _recipe_by_id(store, config["recipeId"], run.get("projectId", ""))
    except ValueError:
        child_recipe = next((recipe for recipe in run.get("embeddedRecipes") or []
                             if recipe.get("recipeId") == config["recipeId"]), None)
        if child_recipe is None:
            raise
    if child_recipe.get("revision") != config["revision"]:
        raise ValueError("Subflow Recipe revision no longer matches its pinned revision.")
    if child_recipe.get("executableDigest") != config["executableDigest"]:
        raise ValueError("Subflow Recipe digest no longer matches its pinned digest.")
    ancestry = run.get("ancestry") or [run["recipeId"]]
    if child_recipe["recipeId"] in ancestry:
        raise ValueError("Recursive Recipe subflow invocation is not allowed.")
    child_definition, child_bindings = _validate_definition(child_recipe)
    attempt = int(record.get("attempt", 1))
    child_id = "recipe_run_" + hashlib.sha256(
        (run["runId"] + ":" + node["nodeId"] + ":" + str(attempt)).encode("utf-8")
    ).hexdigest()[:24]
    child_path, _ = _run_paths(store, child_id)
    if child_path.exists():
        raise ValueError("Subflow child run identity already exists unexpectedly.")
    child = _new_run(child_recipe, child_definition, child_bindings, run["inputs"], child_id,
                     run.get("projectId", ""), [*ancestry, child_recipe["recipeId"]],
                     {"runId": run["runId"], "nodeId": node["nodeId"]})
    if run.get("embeddedRecipes"):
        child["embeddedRecipes"] = run["embeddedRecipes"]
    child_action, _ = _advance(child, False)
    _atomic_write(child_path, child)
    record.update({"childRunId": child_id, "attempt": attempt, "childRecipeId": child_recipe["recipeId"]})
    return child_action


def _sync_subflows(store, run):
    changed = False
    for node in run["definition"]["spec"]["nodes"]:
        record = run["nodes"][node["nodeId"]]
        child_id = record.get("childRunId")
        if node.get("kind") != "pkm.subflow/v1" or record["state"] != "running" or not child_id:
            continue
        child_path, _ = _run_paths(store, child_id)
        child = _load_run(child_path)
        if child["status"] == "completed":
            record.update({"state": "succeeded", "outcome": "succeeded",
                           "result": {"child_run_id": child_id, "child_result": _current_result(child)}, "error": "",
                           "completedAt": child.get("terminalAt") or child.get("updatedAt")})
            changed = True
        elif child["status"] == "failed":
            record.update({"state": "failed", "outcome": "failed", "result": {"child_run_id": child_id},
                           "error": "Pinned sub-Recipe run failed.",
                           "completedAt": child.get("terminalAt") or child.get("updatedAt")})
            run["status"] = "failed"
            changed = True
    return changed


def _command_task_paths(store, run_id, node_id, attempt):
    directory = store / ".pkm" / "state" / "recipe-runs" / "tasks"
    stem = "{}-{}-{}".format(run_id, node_id, attempt)
    return directory / (stem + ".spec.json"), directory / (stem + ".result.json")


def _load_python_environment(registry_path, environment_id):
    if not registry_path:
        return None, "PKM Python environment registry is unavailable."
    try:
        environments = json.loads(Path(registry_path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "PKM Python environment registry does not exist."
    except Exception as error:
        return None, "PKM Python environment registry cannot be read: " + str(error)
    environment = next((item for item in environments if isinstance(item, dict)
                        and item.get("id") == environment_id), None) if isinstance(environments, list) else None
    if not environment:
        return None, "PKM Python environment is not registered: " + environment_id
    interpreter = environment.get("python")
    if not isinstance(interpreter, str) or not os.path.isabs(interpreter) or not Path(interpreter).is_file():
        return None, "PKM Python environment interpreter is missing or invalid: " + environment_id
    return interpreter, None


def _script_command_spec(config, inputs, registry_path, script_path):
    runtime = config["runtime"]
    preflight_error = None
    if runtime == "bash":
        if os.name == "nt":
            program = None
            preflight_error = "Bash Script nodes are supported only on Linux and macOS."
        else:
            program = shutil.which("bash")
            if not program:
                preflight_error = "Bash executable was not found."
        arguments = [str(script_path)]
    elif runtime == "powershell":
        if os.name != "nt":
            program = None
            preflight_error = "PowerShell Script nodes are supported only on Windows."
        else:
            program = shutil.which("powershell.exe") or shutil.which("powershell")
            if not program:
                preflight_error = "Windows PowerShell executable was not found."
        arguments = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script_path)]
    else:
        program, preflight_error = _load_python_environment(registry_path, config["environmentId"])
        arguments = [str(script_path)]
    return {
        "program": program or "",
        "args": arguments,
        "timeoutSeconds": config.get("timeoutSeconds", 300),
        "maxOutputBytes": config.get("maxOutputBytes", 65536),
        "cleanupPath": str(script_path),
        **({"preflightError": preflight_error} if preflight_error else {}),
        **({"cwd": _render_template(config["cwd"], inputs)} if config.get("cwd") else {}),
    }


def _start_command(store, run, node, environments_registry=None):
    record = run["nodes"][node["nodeId"]]
    if record.get("background"):
        return False
    config = node["config"]
    attempt = int(record.get("attempt", 1))
    spec_path, result_path = _command_task_paths(store, run["runId"], node["nodeId"], attempt)
    if node.get("kind") == SCRIPT_NODE_KIND:
        extension = {"bash": ".sh", "powershell": ".ps1", "python": ".py"}[config["runtime"]]
        script_path = spec_path.with_name(spec_path.name + extension)
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script_path.write_text(_render_template(config["script"], run["inputs"]), encoding="utf-8")
        spec = _script_command_spec(config, run["inputs"], environments_registry, script_path)
    else:
        spec = {
            "program": _render_template(config["program"], run["inputs"]),
            "args": [_render_template(argument, run["inputs"]) for argument in config.get("args", [])],
            "timeoutSeconds": config.get("timeoutSeconds", 300),
            "maxOutputBytes": config.get("maxOutputBytes", 65536),
            **({"cwd": _render_template(config["cwd"], run["inputs"])} if config.get("cwd") else {}),
        }
    _atomic_write(spec_path, spec)
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--recipe-command-worker",
         str(spec_path), str(result_path)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True, **_background_process_options())
    record.update({"attempt": attempt, "background": {
        "state": "running", "launcherPid": process.pid, "resultPath": str(result_path),
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "command": {"program": spec["program"], "args": spec["args"]},
    }})
    return True


def _sync_commands(run):
    changed = False
    for node in run["definition"]["spec"]["nodes"]:
        if node.get("kind") not in {COMMAND_NODE_KIND, SCRIPT_NODE_KIND}:
            continue
        record = run["nodes"][node["nodeId"]]
        background = record.get("background") or {}
        result_path = Path(background.get("resultPath", "")) if background.get("resultPath") else None
        if record.get("state") != "running" or background.get("state") != "running" or not result_path or not result_path.exists():
            continue
        result = json.loads(result_path.read_text(encoding="utf-8"))
        outcome = "succeeded" if result.get("ok") else "failed"
        record.update({"state": outcome, "outcome": outcome, "result": result,
                       "error": "" if result.get("ok") else str(result.get("error") or "Command failed."),
                       "completedAt": result.get("completed_at")})
        background.update({"state": outcome, "completedAt": result.get("completed_at")})
        changed = True
    return changed


def _command_action(run, node):
    background = run["nodes"][node["nodeId"]].get("background") or {}
    return {"kind": "wait_for_background", "run_id": run["runId"], "node_id": node["nodeId"],
            "state": background.get("state", "starting"), "started_at": background.get("startedAt"),
            "command": background.get("command"), "poll_with": "recipe_run_get"}


def _human_gate_action(run, node):
    record = run["nodes"][node["nodeId"]]
    if not record.get("challengeId"):
        attempt = int(record.get("attempt", 1))
        record["attempt"] = attempt
        record["challengeId"] = "gate_" + hashlib.sha256(
            (run["runId"] + ":" + node["nodeId"] + ":" + str(attempt)).encode("utf-8")
        ).hexdigest()[:24]
    config = node["config"]
    return {"kind": "request_user_input", "run_id": run["runId"], "node_id": node["nodeId"],
            "challenge_id": record["challengeId"], "prompt": config["prompt"],
            "input_kind": config["inputKind"], "choices": config.get("choices", []),
            "required": True, "submit_tool": "recipe_run_submit_input"}


def _subflow_action(store, run, node):
    record = run["nodes"][node["nodeId"]]
    child_path, _ = _run_paths(store, record["childRunId"])
    child = _load_run(child_path)
    child_action, _ = _advance(child, False)
    return {"kind": "run_subrecipe", "run_id": run["runId"], "node_id": node["nodeId"],
            "child_run_id": child["runId"],
            "pinned_recipe": {"recipe_id": child["recipeId"], "revision": child["recipeRevision"],
                              "executable_digest": child["executableDigest"]},
            "child_status": child["status"], "child_next_action": child_action}


def _materialize_subflow_action(store, run, action):
    if action.get("kind") == "execute_node" and action["node"].get("kind") == "pkm.subflow/v1":
        child_action = _bind_subflow(store, run, action["node"])
        materialized = _subflow_action(store, run, action["node"])
        materialized["child_next_action"] = child_action
        return materialized, True
    if action.get("kind") == "report_node":
        node = next(item for item in run["definition"]["spec"]["nodes"]
                    if item["nodeId"] == action["node_id"])
        if node.get("kind") == "pkm.subflow/v1" and run["nodes"][node["nodeId"]].get("childRunId"):
            return _subflow_action(store, run, node), False
    return action, False


def _materialize_runtime_action(store, run, action, environments_registry=None):
    if action.get("kind") == "execute_node":
        node = action["node"]
        if node.get("kind") in {COMMAND_NODE_KIND, SCRIPT_NODE_KIND}:
            changed = _start_command(store, run, node, environments_registry)
            return _command_action(run, node), changed
        if node.get("kind") == HUMAN_GATE_NODE_KIND:
            before = run["nodes"][node["nodeId"]].get("challengeId")
            materialized = _human_gate_action(run, node)
            return materialized, before != materialized["challenge_id"]
    if action.get("kind") == "report_node":
        node = next(item for item in run["definition"]["spec"]["nodes"]
                    if item["nodeId"] == action["node_id"])
        if node.get("kind") in {COMMAND_NODE_KIND, SCRIPT_NODE_KIND}:
            return _command_action(run, node), False
        if node.get("kind") == HUMAN_GATE_NODE_KIND:
            before = run["nodes"][node["nodeId"]].get("challengeId")
            materialized = _human_gate_action(run, node)
            return materialized, before != materialized["challenge_id"]
    return _materialize_subflow_action(store, run, action)


def _ready_nodes(run):
    states = run["nodes"]
    ready = []
    for node in run["definition"]["spec"]["nodes"]:
        if states[node["nodeId"]]["state"] != "pending":
            continue
        dependencies = [dependency for dependency in node.get("dependsOn", []) if not dependency.get("loop")]
        if all(states[dependency["from"]].get("outcome", states[dependency["from"]]["state"])
               in dependency.get("accept", ["succeeded"]) for dependency in dependencies):
            ready.append(node)
    return ready


def _skip_unselected_nodes(run):
    changed = False
    states = run["nodes"]
    while True:
        skipped = False
        for node in run["definition"]["spec"]["nodes"]:
            record = states[node["nodeId"]]
            if record["state"] != "pending":
                continue
            dependencies = [dependency for dependency in node.get("dependsOn", []) if not dependency.get("loop")]
            if not dependencies:
                continue
            settled = all(states[dependency["from"]]["state"] in TERMINAL_NODE_STATES for dependency in dependencies)
            selected = all(states[dependency["from"]].get("outcome", states[dependency["from"]]["state"])
                           in dependency.get("accept", ["succeeded"]) for dependency in dependencies)
            if settled and not selected:
                record.update({"state": "skipped", "outcome": "skipped", "result": None,
                               "error": "Dependency outcome did not select this path.",
                               "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
                skipped = True
                changed = True
        if not skipped:
            return changed


def _current_result(run):
    completed = []
    for node in run["definition"]["spec"]["nodes"]:
        record = run["nodes"][node["nodeId"]]
        if record["state"] in TERMINAL_NODE_STATES:
                completed.append({"node_id": node["nodeId"], "outcome": record.get("outcome", record["state"]),
                              "result": record.get("result"), "error": record.get("error")})
    counts = {state: sum(record["state"] == state for record in run["nodes"].values())
              for state in ["pending", "running", "succeeded", "failed"]}
    skipped = sum(record["state"] == "skipped" for record in run["nodes"].values())
    if skipped:
        counts["skipped"] = skipped
    total = len(run["nodes"])
    completed_count = sum(record["state"] in TERMINAL_NODE_STATES for record in run["nodes"].values())
    running_node_id = next((node_id for node_id, record in run["nodes"].items()
                            if record["state"] == "running"), None)
    result = {"completed_nodes": completed, "counts": counts,
              "progress": {"completed": completed_count, "total": total,
                           "percent": round((completed_count / total) * 100) if total else 100,
                           "running_node_id": running_node_id}}
    if running_node_id:
        running_record = run["nodes"][running_node_id]
        result["running_progress"] = {
            "node_id": running_node_id,
            "started_at": running_record.get("startedAt"),
            "last_heartbeat_at": running_record.get("lastHeartbeatAt"),
            "last_progress_at": running_record.get("lastProgressAt"),
            "progress": running_record.get("progress") or {},
            "observability": _node_observability(running_record),
        }
    if run.get("loops"):
        result["control_state"] = {"loops": list(run["loops"].values())}
    return result


def _node_observability(record, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    progress = record.get("progress") if isinstance(record.get("progress"), dict) else {}
    stale_after = progress.get("staleAfterSeconds", 300)
    if isinstance(stale_after, bool) or not isinstance(stale_after, (int, float)):
        stale_after = 300
    stale_after = max(float(stale_after), 1.0)

    def age_seconds(value):
        try:
            parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=datetime.timezone.utc)
            return max(0.0, (now - parsed.astimezone(datetime.timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return None

    heartbeat_age = age_seconds(record.get("lastHeartbeatAt"))
    progress_age = age_seconds(record.get("lastProgressAt"))
    if progress.get("cancellationRequested"):
        state, action = "cancelling", "await-terminal-report"
    elif str(progress.get("waitingOn") or "").strip():
        state, action = "waiting", "await-dependency"
    elif ((progress_age is not None and progress_age >= stale_after * 2)
          or (heartbeat_age is not None and heartbeat_age >= stale_after * 2)):
        state, action = "intervention-required", "checkpoint-cancel-or-reassign"
    elif ((progress_age is not None and progress_age >= stale_after)
          or (heartbeat_age is not None and heartbeat_age >= stale_after)):
        state, action = "stale", "soft-nudge"
    elif progress_age is not None and progress_age >= min(max(stale_after / 2, 30), 120):
        state, action = "quiet", "observe"
    else:
        state, action = "active", "continue"
    return {
        "state": state,
        "recommended_action": action,
        "heartbeat_age_seconds": round(heartbeat_age, 3) if heartbeat_age is not None else None,
        "progress_age_seconds": round(progress_age, 3) if progress_age is not None else None,
        "stale_after_seconds": stale_after,
    }


def _accepted_outcomes(node):
    if node.get("kind") == HUMAN_GATE_NODE_KIND:
        config = node["config"]
        if config["inputKind"] == "approval":
            return ["approved", "rejected", "failed"]
        if config["inputKind"] == "choice":
            return [*config["choices"], "failed"]
        return ["succeeded", "failed"]
    control = node.get("control") or {"mode": "single"}
    if control.get("mode") != "branch":
        return ["succeeded", "failed"]
    return list(dict.fromkeys([*(control.get("cases") or []), "failed"]))


def _advance(run, claim):
    if run["status"] == "failed":
        return {"kind": "none", "reason": "recipe-failed"}, False
    running = next((node for node in run["definition"]["spec"]["nodes"]
                    if run["nodes"][node["nodeId"]]["state"] == "running"), None)
    if running:
        if running.get("kind") == COMMAND_NODE_KIND:
            return _command_action(run, running), False
        if running.get("kind") == HUMAN_GATE_NODE_KIND:
            return _human_gate_action(run, running), False
        return {"kind": "report_node", "run_id": run["runId"], "node_id": running["nodeId"],
                "accepted_outcomes": _accepted_outcomes(running)}, False
    skipped = _skip_unselected_nodes(run)
    required = run["definition"]["spec"]["completion"]["requiredNodes"]
    skipped_required = [node_id for node_id in required if run["nodes"][node_id]["state"] == "skipped"]
    if skipped_required:
        changed = run["status"] != "failed"
        run["status"] = "failed"
        return {"kind": "none", "reason": "required-node-skipped",
                "required_node_ids": skipped_required}, changed or skipped
    if all(run["nodes"][node_id]["state"] == "succeeded" for node_id in required):
        changed = run["status"] != "completed"
        run["status"] = "completed"
        return {"kind": "none", "reason": "recipe-completed"}, changed or skipped
    ready = _ready_nodes(run)
    if ready:
        node = ready[0]
        if not claim:
            return {"kind": "call_recipe_run_next", "run_id": run["runId"]}, False
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        attempt = int(run.setdefault("nodeAttemptCounts", {}).get(node["nodeId"], 0)) + 1
        run["nodeAttemptCounts"][node["nodeId"]] = attempt
        run["nodes"][node["nodeId"]].update({
            "state": "running", "attempt": attempt, "startedAt": now,
            "lastHeartbeatAt": now, "lastProgressAt": now,
            "progress": {
                "phase": "claimed", "message": "Module claimed and awaiting progress.",
                "safeToInterrupt": False, "staleAfterSeconds": 300, "events": [],
            },
        })
        return {"kind": "execute_node", "run_id": run["runId"], "node_id": node["nodeId"],
                "node": node, "inputs": run["inputs"],
            "accepted_outcomes": _accepted_outcomes(node),
            "loop_context": _loop_context(run, node["nodeId"]),
            "knowledge_bindings": run.get("nodeBindings", {}).get(node["nodeId"], [])}, True
    changed = run["status"] != "failed"
    run["status"] = "failed"
    blocked = [node_id for node_id, record in run["nodes"].items() if record["state"] == "pending"]
    return {"kind": "none", "reason": "recipe-blocked", "blocked_node_ids": blocked}, changed


def _run_response(run, action, replayed=False):
    return _response(ok=True, run_id=run["runId"], recipe={"recipe_id": run["recipeId"],
                     "revision": run["recipeRevision"], "executable_digest": run["executableDigest"]},
                     status=run["status"], version=run["version"], current_result=_current_result(run),
                     usage=_usage_summary(run), next_action=action, replayed=replayed)


def _finalize_terminal_run(store, run):
    if run.get("status") not in {"completed", "failed"}:
        return False
    if run.get("healthReceipt"):
        return False
    now = run.get("updatedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat()
    run.setdefault("terminalAt", now)
    for record in (run.get("nodes") or {}).values():
        if record.get("state") in TERMINAL_NODE_STATES:
            record.setdefault("completedAt", run["terminalAt"])
    finalize_run_health(store, run)
    return True


def _receipt(run, command_id, fingerprint):
    existing = run["receipts"].get(command_id)
    if not existing:
        return None
    if existing["fingerprint"] != fingerprint:
        raise ValueError("command_id was reused with different parameters.")
    replay = json.loads(existing["response"])
    replay["replayed"] = True
    return _json(replay)


def _store_receipt(run, command_id, fingerprint, response):
    run["receipts"][command_id] = {"fingerprint": fingerprint, "response": response}
    if len(run["receipts"]) > 500:
        oldest = next(iter(run["receipts"]))
        del run["receipts"][oldest]


def _run_retry_count(run):
    return sum(max(0, int(count) - 1) for count in (run.get("nodeAttemptCounts") or {}).values())


def _run_failure_count(run):
    failed_attempts = {
        (node_id, int(record.get("attempt", 1)))
        for node_id, record in run.get("nodes", {}).items()
        if record.get("state") == "failed"
    }
    for loop in (run.get("loops") or {}).values():
        for iteration in loop.get("history") or []:
            failed_attempts.update(
                (node_id, int(record.get("attempt", iteration.get("iteration", 1))))
                for node_id, record in (iteration.get("nodes") or {}).items()
                if record.get("state") == "failed"
            )
    return len(failed_attempts)


def _recipe_usage_groups(store, recipe_id="", limit=50):
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > USAGE_SUMMARY_GROUP_LIMIT:
        raise ValueError("limit must be an integer from 1 to {}.".format(USAGE_SUMMARY_GROUP_LIMIT))
    if recipe_id and (not isinstance(recipe_id, str) or len(recipe_id) > 256):
        raise ValueError("recipe_id must be a string no longer than 256 characters.")
    directory = store / ".pkm" / "state" / "recipe-runs"
    paths = sorted(directory.glob("recipe_run_*.json"),
                   key=lambda path: path.stat().st_mtime, reverse=True)
    scanned = paths[:USAGE_SUMMARY_RUN_SCAN_LIMIT]
    groups = {}
    for path in scanned:
        try:
            run = _load_run(path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if recipe_id and run.get("recipeId") != recipe_id:
            continue
        key = (str(run.get("recipeId") or ""), run.get("recipeRevision"))
        group = groups.setdefault(key, {
            "recipe_id": key[0], "recipe_name": str(run.get("recipeName") or key[0])[:256],
            "revision": key[1], "run_count": 0, "measured_tokens": 0,
            "estimated_tokens": 0, "runs_with_measured_usage": 0,
            "runs_with_unknown_usage": 0, "retries": 0, "failures": 0, "failed_runs": 0,
        })
        usage = run.get("usage") or {}
        measured = usage.get("measuredTokens") or {}
        estimated = int(usage.get("estimatedTokens", 0))
        group["run_count"] += 1
        group["measured_tokens"] += int(measured.get("total_tokens", 0))
        group["estimated_tokens"] += estimated
        has_measured = int(usage.get("measuredReports", 0)) > 0
        group["runs_with_measured_usage"] += int(has_measured)
        group["runs_with_unknown_usage"] += int(
            not has_measured or int(usage.get("unknownModelCalls", 0)) > 0)
        group["retries"] += _run_retry_count(run)
        group["failures"] += _run_failure_count(run)
        group["failed_runs"] += int(run.get("status") == "failed")
    result = []
    for group in groups.values():
        runs = group["run_count"]
        group["average_measured_tokens_per_run"] = round(group.pop("measured_tokens") / runs, 2)
        group["average_estimated_tokens_per_run"] = round(group.pop("estimated_tokens") / runs, 2)
        result.append(group)
    result.sort(key=lambda item: (-item["run_count"], item["recipe_id"], str(item["revision"])))
    return result[:limit], len(paths) > len(scanned), len(scanned)


def register_recipe_tools(mcp, store, subscription_cache=None, environments_registry=None):
    store = Path(store)

    @mcp.tool()
    def recipe_capabilities() -> str:
        """Proactively discover reusable or ad hoc Recipe workflows before planning substantial multi-step work.

        Use for coding, research, debugging, and operational tasks with a stable sequence,
        dependencies, branching, bounded repetition, or reusable inputs and outputs. The user
        does not need to mention Recipes. Next call recipe_search with the complete task contract.
        """
        return _response(
            ok=True,
            capability="pkm-recipes",
            version=RECIPE_SCHEMA_VERSION,
            proactive=True,
            use_when=[
                "substantial multi-step task",
                "stable or reusable sequence",
                "dependencies, branching, or bounded repetition",
            ],
            next_tool="recipe_search",
            tools=[
                "recipe_search",
                "recipe_create_from_skill",
                "recipe_run_start",
                "recipe_run_start_adhoc",
                "recipe_run_get",
                "recipe_run_next",
                "recipe_run_progress",
                "recipe_run_report",
                "recipe_run_submit_input",
                "recipe_usage_summary",
            ],
            execution={
                "definition_schema": DEFINITION_SCHEMA,
                "strategy": "persisted-control-state-machine",
                "adapter_protocol": "next-action-report/v1",
                "next_is_claim": True,
                "dynamic_v2": True,
                "supported_controls": ["branch", "bounded-loop", "pinned-subrecipe",
                                       "background-command", "mandatory-human-gate"],
            },
            usage_accounting={
                "report_parameter": "usage_json",
                "measured_and_estimated_are_separate": True,
                "protocol_payload_estimate_is_separate": True,
                "attribution": ["recipeRunId", "nodeId", "attempt"],
                "measured_token_fields": list(MEASURED_TOKEN_FIELDS),
                "summary_tool": "recipe_usage_summary",
                "host_tokens": "unknown unless supplied from measured provider telemetry",
            },
            run_health={
                "receipt_schema": "pkm.recipe.run-health/v1",
                "taxonomy": ["healthy", "environment-failure", "input-failure",
                             "implementation-failure", "recipe-friction", "recipe-failure"],
                "healthy_path_model_calls": 0,
                "evolution": "evidence-thresholded-queued-candidate-request-with-human-promotion",
            },
            qualification="metadata-only-v1",
            subscribed_recipes="read-only; review and explicitly fork or import before execution",
            design_persistence="recipe_create_from_skill-for-declared-skill-gaps-or-extension-authoring-bridge",
        )

    @mcp.tool()
    def recipe_usage_summary(recipe_id: str = "", limit: int = 50) -> str:
        """Aggregate bounded Recipe usage by Recipe identity and revision.

        Child subflows are independent runs and are counted only under their own Recipe.
        Measured provider tokens, caller estimates, and protocol payload estimates remain separate.
        """
        try:
            summaries, scan_truncated, runs_scanned = _recipe_usage_groups(store, recipe_id, limit)
            return _response(ok=True, summaries=summaries, runs_scanned=runs_scanned,
                             scan_truncated=scan_truncated,
                             accounting="one-run-per-recipe-revision; child-runs-are-not-rolled-up")
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-usage-summary-failed",
                                              "message": str(error)})

    @mcp.tool()
    def recipe_search(query: str = "", category: str = "", project_id: str = "", limit: int = 10,
                      task_contract_json: str = "{}") -> str:
        """Find Recipe candidates for a task contract; use proactively even when the user did not mention Recipes.

        Qualify candidates by purpose, inputs, outputs, constraints, and graph shape. A no-match
        response is valid and returns a design_recipe next action; never force a weak candidate.
        """
        try:
            contract = _parse_json(task_contract_json, "task_contract_json")
            return _search(store, query, category, project_id, limit, contract, subscription_cache)
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-search-failed", "message": str(error)})

    @mcp.tool()
    def recipe_create_from_skill(name: str, definition_json: str, command_id: str,
                                 source_skill_id: str, source_skill_hash: str,
                                 description: str = "", category: str = "",
                                 scope: str = "global", project_id: str = "") -> str:
        """Create an idempotent Library Recipe when a retrieved Skill explicitly requires one and recipe_search found no qualified match.

        Design the complete reusable workflow first. This tool binds the source Skill as required
        knowledge on the first node. Do not use it for one-off work or when the Skill did not declare
        a Recipe gap; use recipe_run_start_adhoc for concrete one-off execution instead.
        """
        try:
            definition = _parse_json(definition_json, "definition_json")
            recipe, replayed = _author_recipe_from_skill(
                store, name, description, category, definition, command_id,
                source_skill_id, source_skill_hash, scope, project_id)
            return _response(ok=True, outcome="recipe-created", recipe=_recipe_summary(recipe), replayed=replayed,
                             next_action={"kind": "qualify_recipe", "candidate_recipe_ids": [recipe["recipeId"]]})
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-create-from-skill-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_start(recipe_id: str, command_id: str, inputs_json: str = "{}", project_id: str = "",
                         expected_revision: int = 0, expected_digest: str = "") -> str:
        """Create an idempotent lazy run pinned to one Recipe revision and digest."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            recipe = _recipe_by_id(store, recipe_id, project_id)
            definition, node_bindings = _validate_definition(recipe)
            if expected_revision and recipe.get("revision") != expected_revision:
                raise ValueError("Recipe revision does not match expected_revision.")
            if expected_digest and recipe.get("executableDigest") != expected_digest:
                raise ValueError("Recipe digest does not match expected_digest.")
            inputs = _normalize_run_inputs(definition, _parse_json(inputs_json, "inputs_json"))
            fingerprint = _fingerprint({"recipe_id": recipe_id, "project_id": project_id, "inputs": inputs,
                                        "revision": expected_revision, "digest": expected_digest})
            run_id = "recipe_run_" + hashlib.sha256(command_id.encode("utf-8")).hexdigest()[:24]
            path, lock = _run_paths(store, run_id)
            with _file_lock(lock):
                if path.exists():
                    run = _load_run(path)
                    replay = _receipt(run, command_id, fingerprint)
                    if replay:
                        return replay
                    raise ValueError("Deterministic run identity already exists for another command.")
                run = _new_run(recipe, definition, node_bindings, inputs, run_id, project_id)
                action, _ = _advance(run, False)
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-start-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_start_adhoc(name: str, definition_json: str, command_id: str, inputs_json: str = "{}",
                               node_bindings_json: str = "[]") -> str:
        """Create an Agent Session task run from an instance-only workflow without adding it to Recipe Library."""
        try:
            name = str(name or "").strip()
            if not name or not command_id.strip():
                raise ValueError("name and command_id are required.")
            definition = _parse_json(definition_json, "definition_json")
            node_bindings = _parse_json(node_bindings_json, "node_bindings_json", list)
            inputs = _parse_json(inputs_json, "inputs_json")
            executable_digest = _fingerprint({"definition": definition, "nodeBindings": node_bindings})
            recipe_id = "adhoc_recipe_" + executable_digest[:24]
            recipe = {"recipeId": recipe_id, "name": name, "revision": 1,
                      "executableDigest": executable_digest, "definition": definition,
                      "nodeBindings": node_bindings, "origin": {"kind": "agent-session-adhoc"}}
            definition, bindings = _validate_definition(recipe)
            inputs = _normalize_run_inputs(definition, inputs)
            fingerprint = _fingerprint({"name": name, "definition": definition,
                                        "node_bindings": node_bindings, "inputs": inputs})
            run_id = "recipe_run_" + hashlib.sha256(command_id.encode("utf-8")).hexdigest()[:24]
            path, lock = _run_paths(store, run_id)
            with _file_lock(lock):
                if path.exists():
                    run = _load_run(path)
                    replay = _receipt(run, command_id, fingerprint)
                    if replay:
                        return replay
                    raise ValueError("Deterministic run identity already exists for another command.")
                run = _new_run(recipe, definition, bindings, inputs, run_id)
                action, _ = _advance(run, False)
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-start-adhoc-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_get(run_id: str) -> str:
        """Read current Recipe results and the next non-claiming action."""
        try:
            path, lock = _run_paths(store, run_id)
            with _file_lock(lock):
                run = _load_run(path)
                changed = _sync_commands(run)
                changed = _sync_subflows(store, run) or changed
                action, advanced = _advance(run, False)
                changed = changed or advanced
                action, materialized = _materialize_runtime_action(store, run, action, environments_registry)
                changed = changed or materialized
                if changed:
                    run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                changed = _finalize_terminal_run(store, run) or changed
                if changed:
                    run["version"] += 1
                    _atomic_write(path, run)
                return _run_response(run, action)
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-get-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_next(run_id: str, command_id: str) -> str:
        """Atomically claim and return exactly one ready Recipe node for the Agent to execute."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            path, lock = _run_paths(store, run_id)
            fingerprint = _fingerprint({"run_id": run_id, "operation": "next"})
            with _file_lock(lock):
                run = _load_run(path)
                replay = _receipt(run, command_id, fingerprint)
                if replay:
                    return replay
                changed = _sync_commands(run)
                changed = _sync_subflows(store, run) or changed
                action, advanced = _advance(run, True)
                changed = changed or advanced
                action, materialized = _materialize_runtime_action(store, run, action, environments_registry)
                changed = changed or materialized
                if changed:
                    run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                changed = _finalize_terminal_run(store, run) or changed
                if changed:
                    run["version"] += 1
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-next-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_progress(run_id: str, node_id: str, command_id: str,
                            progress_json: str = "{}") -> str:
        """Persist a heartbeat and structured progress for the currently running Recipe module."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            value = _parse_json(progress_json, "progress_json")
            allowed = {
                "phase", "message", "checkpoint", "nextStep", "completed", "total", "etaSeconds",
                "waitingOn", "safeToInterrupt", "sideEffects", "staleAfterSeconds", "events", "progressed",
                "cancellationRequested", "toolCallCount", "currentValidation",
            }
            unknown = sorted(set(value) - allowed)
            if unknown:
                raise ValueError("progress_json contains unknown fields: {}.".format(", ".join(unknown)))
            for key in ["phase", "message", "checkpoint", "nextStep", "waitingOn", "currentValidation"]:
                if key in value and not isinstance(value[key], str):
                    raise ValueError("{} must be a string.".format(key))
            for key in ["completed", "total", "etaSeconds", "staleAfterSeconds", "toolCallCount"]:
                if key in value and (isinstance(value[key], bool) or not isinstance(value[key], (int, float))
                                     or value[key] < 0):
                    raise ValueError("{} must be a non-negative number.".format(key))
            if "safeToInterrupt" in value and not isinstance(value["safeToInterrupt"], bool):
                raise ValueError("safeToInterrupt must be a boolean.")
            if "cancellationRequested" in value and not isinstance(value["cancellationRequested"], bool):
                raise ValueError("cancellationRequested must be a boolean.")
            side_effects = value.get("sideEffects", [])
            if not isinstance(side_effects, list) or any(not isinstance(item, str) for item in side_effects):
                raise ValueError("sideEffects must be an array of strings.")
            events = value.get("events", [])
            if not isinstance(events, list) or any(not isinstance(item, dict) or not isinstance(item.get("message"), str)
                                                   for item in events):
                raise ValueError("events must be an array of objects with message.")
            path, lock = _run_paths(store, run_id)
            fingerprint = _fingerprint({"run_id": run_id, "node_id": node_id, "progress": value})
            with _file_lock(lock):
                run = _load_run(path)
                replay = _receipt(run, command_id, fingerprint)
                if replay:
                    return replay
                record = run["nodes"].get(node_id)
                if not record or record.get("state") != "running":
                    raise ValueError("Progress can only be recorded for the currently running node.")
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                current = dict(record.get("progress") or {})
                existing_events = list(current.get("events") or [])
                normalized_events = [
                    {
                        "at": str(event.get("at") or now),
                        "level": str(event.get("level") or "info"),
                        "message": event["message"],
                    }
                    for event in events
                ]
                current.update({key: item for key, item in value.items() if key not in {"events", "progressed"}})
                current["events"] = (existing_events + normalized_events)[-20:]
                record["progress"] = current
                record["lastHeartbeatAt"] = now
                if value.get("progressed", True):
                    record["lastProgressAt"] = now
                run["updatedAt"] = now
                run["version"] += 1
                response = _run_response(run, {
                    "kind": "report_node", "run_id": run_id, "node_id": node_id,
                    "accepted_outcomes": _accepted_outcomes(
                        next(item for item in run["definition"]["spec"]["nodes"] if item["nodeId"] == node_id)),
                })
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-progress-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_report(run_id: str, node_id: str, outcome: str, command_id: str,
                          result_json: str = "null", error: str = "",
                          usage_json: str = "null") -> str:
        """Commit one claimed node outcome, optional measured/estimated usage, and claim the next action."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            if not isinstance(usage_json, str):
                raise ValueError("usage_json must be a JSON string.")
            if len(usage_json.encode("utf-8")) > 65536:
                raise ValueError("usage_json must not exceed 65536 UTF-8 bytes.")
            result = _parse_json(result_json, "result_json", None)
            usage_value = _normalize_usage(_parse_json(usage_json, "usage_json", None))
            path, lock = _run_paths(store, run_id)
            fingerprint = _fingerprint({"run_id": run_id, "node_id": node_id, "outcome": outcome,
                                        "result": result, "error": error, "usage": usage_value})
            with _file_lock(lock):
                run = _load_run(path)
                replay = _receipt(run, command_id, fingerprint)
                if replay:
                    return replay
                record = run["nodes"].get(node_id)
                if not record or record["state"] != "running":
                    raise ValueError("Only the currently claimed running node can report an outcome.")
                node = next(item for item in run["definition"]["spec"]["nodes"] if item["nodeId"] == node_id)
                if node.get("kind") in {"pkm.subflow/v1", COMMAND_NODE_KIND, SCRIPT_NODE_KIND, HUMAN_GATE_NODE_KIND}:
                    raise ValueError("This node kind has a dedicated runtime adapter and cannot be reported manually.")
                accepted = set(_accepted_outcomes(node))
                if outcome not in accepted:
                    raise ValueError("outcome is not accepted by the claimed node.")
                attempt = int(record.get("attempt", 1))
                protocol_estimate = _protocol_payload_estimate(
                    {"run_id": run_id, "node_id": node_id, "attempt": attempt,
                     "outcome": outcome, "result": result, "error": error, "usage": usage_value})
                _record_usage(run, node_id, attempt, usage_value, protocol_estimate)
                state = "failed" if outcome == "failed" else "succeeded"
                completed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
                record.update({"state": state, "outcome": outcome, "result": result, "error": str(error or ""),
                               "completedAt": completed_at})
                action = _apply_loop_outcome(run, node_id, outcome)
                if action is None:
                    action, _ = _advance(run, True)
                action, _ = _materialize_runtime_action(store, run, action, environments_registry)
                run["version"] += 1
                run["updatedAt"] = completed_at
                _finalize_terminal_run(store, run)
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error_value:
            return _response(ok=False, error={"code": "recipe-run-report-failed", "message": str(error_value)})

    @mcp.tool()
    def recipe_run_submit_input(run_id: str, node_id: str, challenge_id: str,
                                response_json: str, command_id: str) -> str:
        """Submit required user input to a human gate; ordinary Recipe reports cannot replace this evidence."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            response = _parse_json(response_json, "response_json")
            path, lock = _run_paths(store, run_id)
            fingerprint = _fingerprint({"run_id": run_id, "node_id": node_id,
                                        "challenge_id": challenge_id, "response": response})
            with _file_lock(lock):
                run = _load_run(path)
                replay = _receipt(run, command_id, fingerprint)
                if replay:
                    return replay
                record = run["nodes"].get(node_id)
                node = next((item for item in run["definition"]["spec"]["nodes"]
                             if item["nodeId"] == node_id), None)
                if not record or record.get("state") != "running" or not node or node.get("kind") != HUMAN_GATE_NODE_KIND:
                    raise ValueError("Only the currently waiting human gate can accept user input.")
                if not challenge_id or challenge_id != record.get("challengeId"):
                    raise ValueError("Human gate challenge_id is stale or invalid.")
                config = node["config"]
                if config["inputKind"] == "approval":
                    if not isinstance(response.get("approved"), bool):
                        raise ValueError("Approval input requires an explicit boolean approved value.")
                    outcome = "approved" if response["approved"] else "rejected"
                elif config["inputKind"] == "text":
                    if not isinstance(response.get("text"), str) or not response["text"].strip():
                        raise ValueError("Text input requires a non-empty text value.")
                    outcome = "succeeded"
                else:
                    choice = response.get("choice")
                    if choice not in config["choices"]:
                        raise ValueError("Choice input must select one configured choice.")
                    outcome = choice
                responded_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
                record.update({"state": "succeeded", "outcome": outcome, "result": response,
                               "error": "", "respondedAt": responded_at, "completedAt": responded_at,
                               "humanIntervention": True})
                action = _apply_loop_outcome(run, node_id, outcome)
                if action is None:
                    action, _ = _advance(run, True)
                action, _ = _materialize_runtime_action(store, run, action, environments_registry)
                run["version"] += 1
                run["updatedAt"] = responded_at
                _finalize_terminal_run(store, run)
                response_value = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response_value)
                _atomic_write(path, run)
                return response_value
        except Exception as error_value:
            return _response(ok=False, error={"code": "recipe-run-submit-input-failed",
                                              "message": str(error_value)})

    return {name: value for name, value in locals().items() if name.startswith("recipe_")}


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--recipe-command-worker":
    try:
        _execute_command_worker(sys.argv[2], sys.argv[3])
    finally:
        Path(sys.argv[2]).unlink(missing_ok=True)