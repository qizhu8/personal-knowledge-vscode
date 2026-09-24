"""Agent-facing Recipe discovery and persisted workflow state-machine tools."""

import contextlib
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

RECIPE_SCHEMA_VERSION = "1.4.0"
API_SCHEMA = "pkm.recipe.api/v1"
RUN_SCHEMA = "pkm.recipe.run/v1"
DEFINITION_SCHEMA = "pkm.workflow.definition/v1"
TERMINAL_NODE_STATES = {"succeeded", "failed", "skipped"}
COMMAND_NODE_KIND = "pkm.step.command/v1"
SCRIPT_NODE_KIND = "pkm.step.script/v1"
HUMAN_GATE_NODE_KIND = "pkm.gate.human/v1"
TEMPLATE = re.compile(r"\$\{inputs\.([A-Za-z][A-Za-z0-9._-]{0,127})\}")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _response(**values):
    return _json({"schema": API_SCHEMA, **values})


def _fingerprint(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


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
            process_options = {"start_new_session": True} if os.name != "nt" else {
                "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            process = subprocess.Popen(
                [spec["program"], *spec["args"]], cwd=spec.get("cwd") or None,
                stdin=subprocess.DEVNULL, stdout=stdout_handle, stderr=stderr_handle,
                shell=False, **process_options)
            try:
                exit_code = process.wait(timeout=spec["timeoutSeconds"])
                timed_out = False
            except subprocess.TimeoutExpired:
                timed_out = True
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, check=False)
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
    path = store / ".pkm" / "state" / "projects.json"
    if not path.exists():
        return []
    envelope = json.loads(path.read_text(encoding="utf-8"))
    payload = envelope.get("payload")
    if not isinstance(payload, dict) or _fingerprint(payload) != envelope.get("digest"):
        raise ValueError("Project store digest is invalid.")
    state = payload.get("state") or {}
    recipes = state.get("recipes") or []
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
    recipe = {"recipeId": recipe_id, "scope": scope, "category": str(category or ""),
              "name": str(name).strip(), "description": str(description or "").strip(),
              "metadata": {"applicableFunctions": [], "solution": str(description or "").strip(),
                           "requiredInputs": [], "expectedOutputs": []},
              "definition": definition, "nodeBindings": [{"nodeId": first_node, "bindings": [binding]}],
              "executableDigest": executable_digest, "revision": 1,
              "origin": {"kind": "skill-recipe-gap", "skillId": source_skill_id}}
    if scope == "project":
        if not str(project_id or "").strip():
            raise ValueError("project_id is required for a Project Recipe.")
        recipe["projectId"] = project_id
    _validate_definition(recipe)
    fingerprint = _fingerprint({"name": recipe["name"], "description": recipe["description"],
                                "category": recipe["category"], "definition": definition,
                                "scope": scope, "project_id": project_id,
                                "source_skill_id": source_skill_id, "source_skill_hash": source_skill_hash})
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
        if scope == "project" and not any(project.get("projectId") == project_id
                                           for project in payload["state"].get("projects") or []):
            raise ValueError("Project Recipe references an unknown Project.")
        recipes = payload["state"].setdefault("recipes", [])
        if any(item.get("recipeId") == recipe_id for item in recipes):
            raise ValueError("Generated Recipe identity already exists.")
        recipes.append(recipe)
        store_version = envelope["storeVersion"] + 1
        payload["receipts"].append({"commandId": command_id, "fingerprint": fingerprint,
                                    "operation": "recipe-create-from-skill",
                                    "storeVersion": store_version, "entityId": recipe_id})
        updated = {"schema": 1, "storeVersion": store_version, "payload": payload,
                   "digest": _fingerprint(payload)}
        _atomic_write(path, updated)
        return recipe, False


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
        metadata_fields = [*(metadata.get("requiredInputs") or []), *(metadata.get("expectedOutputs") or [])]
        text = "\n".join(str(value or "") for value in [
            recipe.get("name"), recipe.get("description"), recipe_category,
            *(metadata.get("applicableFunctions") or []), metadata.get("solution"),
            *[field.get("name") for field in metadata_fields if isinstance(field, dict)],
            *[field.get("description") for field in metadata_fields if isinstance(field, dict)],
            *[node.get("nodeId") for node in nodes if isinstance(node, dict)],
            *[node.get("kind") for node in nodes if isinstance(node, dict)],
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
    return {"schema": RUN_SCHEMA, "runId": run_id, "status": "running", "version": 1,
            "recipeId": recipe["recipeId"], "recipeRevision": recipe.get("revision"),
            "executableDigest": recipe.get("executableDigest"), "projectId": project_id,
            "recipeName": str(recipe.get("name") or recipe["recipeId"]),
            "origin": recipe.get("origin") or {"kind": "library"},
            "definition": definition, "nodeBindings": node_bindings, "inputs": inputs,
            "nodes": {node["nodeId"]: {"state": "pending"} for node in definition["spec"]["nodes"]},
            "loops": _initialize_loops(definition), "ancestry": list(ancestry or [recipe["recipeId"]]),
            **({"parent": parent} if parent else {}),
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
    attempt = int(record.get("attempt", 0)) + 1
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
                           "result": {"child_run_id": child_id, "child_result": _current_result(child)}, "error": ""})
            changed = True
        elif child["status"] == "failed":
            record.update({"state": "failed", "outcome": "failed", "result": {"child_run_id": child_id},
                           "error": "Pinned sub-Recipe run failed."})
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
    attempt = int(record.get("attempt", 0)) + 1
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
        close_fds=True, start_new_session=True)
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
                       "error": "" if result.get("ok") else str(result.get("error") or "Command failed.")})
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
        attempt = int(record.get("attempt", 0)) + 1
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
                               "error": "Dependency outcome did not select this path."})
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
    if run.get("loops"):
        result["control_state"] = {"loops": list(run["loops"].values())}
    return result


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
    if all(run["nodes"][node_id]["state"] in {"succeeded", "skipped"} for node_id in required):
        changed = run["status"] != "completed"
        run["status"] = "completed"
        return {"kind": "none", "reason": "recipe-completed"}, changed or skipped
    ready = _ready_nodes(run)
    if ready:
        node = ready[0]
        if not claim:
            return {"kind": "call_recipe_run_next", "run_id": run["runId"]}, False
        run["nodes"][node["nodeId"]]["state"] = "running"
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
                     next_action=action, replayed=replayed)


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
                "recipe_run_report",
                "recipe_run_submit_input",
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
            qualification="metadata-only-v1",
            subscribed_recipes="read-only; review and explicitly fork or import before execution",
            design_persistence="recipe_create_from_skill-for-declared-skill-gaps-or-extension-authoring-bridge",
        )

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
            inputs = _parse_json(inputs_json, "inputs_json")
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
                    run["version"] += 1
                    run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-next-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_report(run_id: str, node_id: str, outcome: str, command_id: str,
                          result_json: str = "null", error: str = "") -> str:
        """Commit one claimed node outcome and atomically return or claim the next action."""
        try:
            if not command_id.strip():
                raise ValueError("command_id is required.")
            result = _parse_json(result_json, "result_json", None)
            path, lock = _run_paths(store, run_id)
            fingerprint = _fingerprint({"run_id": run_id, "node_id": node_id, "outcome": outcome,
                                        "result": result, "error": error})
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
                state = "failed" if outcome == "failed" else "succeeded"
                record.update({"state": state, "outcome": outcome, "result": result, "error": str(error or "")})
                action = _apply_loop_outcome(run, node_id, outcome)
                if action is None:
                    action, _ = _advance(run, True)
                action, _ = _materialize_runtime_action(store, run, action, environments_registry)
                run["version"] += 1
                run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
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
                record.update({"state": "succeeded", "outcome": outcome, "result": response,
                               "error": "", "respondedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
                action = _apply_loop_outcome(run, node_id, outcome)
                if action is None:
                    action, _ = _advance(run, True)
                action, _ = _materialize_runtime_action(store, run, action, environments_registry)
                run["version"] += 1
                run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
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