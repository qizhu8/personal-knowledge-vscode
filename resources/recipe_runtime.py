"""Agent-facing Recipe discovery and lazy v1 DAG execution tools."""

import contextlib
import datetime
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

RECIPE_SCHEMA_VERSION = "1.0.0"
API_SCHEMA = "pkm.recipe.api/v1"
RUN_SCHEMA = "pkm.recipe.run/v1"
DEFINITION_SCHEMA = "pkm.workflow.definition/v1"
TERMINAL_NODE_STATES = {"succeeded", "failed"}


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


def _search(store, query, category, project_id, limit, task_contract):
    terms = [term for term in str(query or "").lower().split() if term]
    category_lower = str(category or "").strip().lower()
    candidates = []
    for recipe in _project_recipes(store):
        if recipe.get("scope") != "global" and recipe.get("projectId") != project_id:
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
        candidates.append(_recipe_summary(recipe, score))
    candidates.sort(key=lambda item: (-item["score"], item["name"] or "", item["recipe_id"] or ""))
    candidates = candidates[:max(1, min(int(limit or 10), 50))]
    if candidates:
        return _response(ok=True, outcome="candidates", qualification="metadata-only-v1",
                         candidates=candidates,
                         next_action={"kind": "qualify_recipe", "candidate_recipe_ids": [item["recipe_id"] for item in candidates],
                                      "task_contract": task_contract})
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
        if node.get("kind") != "pkm.step.noop/v1" or not isinstance(node.get("dependsOn"), list):
            raise ValueError("Recipe contains an unsupported v1 node.")
        if any(dependency.get("from") not in node_ids for dependency in node["dependsOn"]):
            raise ValueError("Recipe dependency references an unknown node.")
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


def _run_paths(store, run_id):
    if not run_id.startswith("recipe_run_") or not all(character.isalnum() or character in "_-" for character in run_id):
        raise ValueError("Invalid Recipe run identity.")
    directory = store / ".pkm" / "state" / "recipe-runs"
    return directory / (run_id + ".json"), directory / (run_id + ".lock")


def _load_run(path):
    if not path.exists():
        raise ValueError("Recipe run was not found.")
    run = json.loads(path.read_text(encoding="utf-8"))
    if run.get("schema") != RUN_SCHEMA:
        raise ValueError("Recipe run schema is unsupported.")
    return run


def _ready_nodes(run):
    states = run["nodes"]
    ready = []
    for node in run["definition"]["spec"]["nodes"]:
        if states[node["nodeId"]]["state"] != "pending":
            continue
        if all(states[dependency["from"]]["state"] in dependency.get("accept", ["succeeded"])
               for dependency in node.get("dependsOn", [])):
            ready.append(node)
    return ready


def _current_result(run):
    completed = []
    for node in run["definition"]["spec"]["nodes"]:
        record = run["nodes"][node["nodeId"]]
        if record["state"] in TERMINAL_NODE_STATES:
            completed.append({"node_id": node["nodeId"], "outcome": record["state"],
                              "result": record.get("result"), "error": record.get("error")})
    return {"completed_nodes": completed,
            "counts": {state: sum(record["state"] == state for record in run["nodes"].values())
                       for state in ["pending", "running", "succeeded", "failed"]}}


def _advance(run, claim):
    running = next((node for node in run["definition"]["spec"]["nodes"]
                    if run["nodes"][node["nodeId"]]["state"] == "running"), None)
    if running:
        return {"kind": "report_node", "run_id": run["runId"], "node_id": running["nodeId"],
                "accepted_outcomes": ["succeeded", "failed"]}, False
    required = run["definition"]["spec"]["completion"]["requiredNodes"]
    if all(run["nodes"][node_id]["state"] == "succeeded" for node_id in required):
        changed = run["status"] != "completed"
        run["status"] = "completed"
        return {"kind": "none", "reason": "recipe-completed"}, changed
    ready = _ready_nodes(run)
    if ready:
        node = ready[0]
        if not claim:
            return {"kind": "call_recipe_run_next", "run_id": run["runId"]}, False
        run["nodes"][node["nodeId"]]["state"] = "running"
        return {"kind": "execute_node", "run_id": run["runId"], "node_id": node["nodeId"],
                "node": node, "inputs": run["inputs"],
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


def register_recipe_tools(mcp, store):
    store = Path(store)

    @mcp.tool()
    def recipe_capabilities() -> str:
        """Discover Recipe search and lazy execution tools and their v1 limits."""
        return _response(ok=True, capability="pkm-recipes", version=RECIPE_SCHEMA_VERSION,
                         tools=["recipe_search", "recipe_run_start", "recipe_run_get", "recipe_run_next", "recipe_run_report"],
                         execution={"definition_schema": DEFINITION_SCHEMA, "strategy": "serial-ready-node",
                                    "next_is_claim": True, "dynamic_v2": False},
                         qualification="metadata-only-v1", design_persistence="unavailable-use-extension-authoring-bridge")

    @mcp.tool()
    def recipe_search(query: str = "", category: str = "", project_id: str = "", limit: int = 10,
                      task_contract_json: str = "{}") -> str:
        """Find accessible Recipe candidates; a no-match response returns a design_recipe next action."""
        try:
            contract = _parse_json(task_contract_json, "task_contract_json")
            return _search(store, query, category, project_id, limit, contract)
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-search-failed", "message": str(error)})

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
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                run = {"schema": RUN_SCHEMA, "runId": run_id, "status": "running", "version": 1,
                       "recipeId": recipe_id, "recipeRevision": recipe.get("revision"),
                       "executableDigest": recipe.get("executableDigest"), "definition": definition,
                       "nodeBindings": node_bindings, "inputs": inputs,
                       "nodes": {node["nodeId"]: {"state": "pending"} for node in definition["spec"]["nodes"]},
                       "receipts": {}, "createdAt": now, "updatedAt": now}
                action, _ = _advance(run, False)
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-run-start-failed", "message": str(error)})

    @mcp.tool()
    def recipe_run_get(run_id: str) -> str:
        """Read current Recipe results and the next non-claiming action."""
        try:
            path, lock = _run_paths(store, run_id)
            with _file_lock(lock):
                run = _load_run(path)
                action, changed = _advance(run, False)
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
                action, changed = _advance(run, True)
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
            if outcome not in TERMINAL_NODE_STATES:
                raise ValueError("outcome must be succeeded or failed.")
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
                record.update({"state": outcome, "result": result, "error": str(error or "")})
                action, _ = _advance(run, True)
                run["version"] += 1
                run["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                response = _run_response(run, action)
                _store_receipt(run, command_id, fingerprint, response)
                _atomic_write(path, run)
                return response
        except Exception as error_value:
            return _response(ok=False, error={"code": "recipe-run-report-failed", "message": str(error_value)})

    return {name: value for name, value in locals().items() if name.startswith("recipe_")}