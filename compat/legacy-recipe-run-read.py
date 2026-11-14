"""Original Recipe run inspection over host-captured files only.

The original getter also reconciles commands, subflows, graph state and health.
Only already-finalized terminal runs can be represented without that authority.
No execution, reconciliation, locks, health writes or external paths are used.
"""

import json


store = None
TERMINAL = {"succeeded", "failed", "skipped"}


def _response(**values):
    return json.dumps({"schema": "pkm.recipe.api/v1", **values},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _usage_summary(run):
    # Projection of resources/recipe_runtime.py::_usage_summary.
    usage = run.get("usage") or {}
    measured = {**{key: 0 for key in (
        "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens",
        "reasoning_tokens")}, **(usage.get("measuredTokens") or {})}
    protocol = usage.get("protocolPayloadEstimate") or {}
    return {
        "measured_tokens": measured,
        "measured_total_tokens": measured["total_tokens"],
        "estimated_tokens": int(usage.get("estimatedTokens", 0)),
        "unknown_model_calls": int(usage.get("unknownModelCalls", 0)),
        "derived_cost_micros_by_currency": dict(sorted((usage.get("derivedCosts") or {}).items())[:32]),
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


def recipe_run_get(run_id: str, detail: str = "full") -> str:
    """Read Recipe state; full is intended for explicit result inspection."""
    try:
        detail = str(detail or "full").strip().lower()
        if detail not in {"compact", "full"}:
            raise ValueError("detail must be compact or full.")
        if not run_id.startswith("recipe_run_") or not all(
                character.isalnum() or character in "_-" for character in run_id):
            raise ValueError("Invalid Recipe run identity.")
        path = store / ".pkm" / "state" / "recipe-runs" / (run_id + ".json")
        if not path.exists():
            raise ValueError("Recipe run was not found.")
        run = json.loads(path.read_text(encoding="utf-8"))
        if run.get("schema") != "pkm.recipe.run/v1":
            raise ValueError("Recipe run schema is unsupported.")
        if run.get("runId") != run_id:
            raise ValueError("BLOCKED: Admitted Recipe run identity does not match its stored identity.")
        nodes = run["definition"]["spec"]["nodes"]
        records = run["nodes"]
        if (run.get("status") not in {"completed", "failed"} or not run.get("healthReceipt")
                or set(records) != {node["nodeId"] for node in nodes}
                or any(record["state"] not in TERMINAL for record in records.values())
                or (run["status"] == "completed" and any(
                    records[node_id]["state"] != "succeeded"
                    for node_id in run["definition"]["spec"]["completion"]["requiredNodes"]))):
            raise ValueError(
                "BLOCKED: Recipe inspection requires unavailable live reconciliation or terminal health authority; "
                "only already-finalized terminal runs are supported.")
        counts = {state: sum(record["state"] == state for record in records.values())
                  for state in ["pending", "running", "succeeded", "failed"]}
        skipped = sum(record["state"] == "skipped" for record in records.values())
        if skipped:
            counts["skipped"] = skipped
        current = {"counts": counts, "progress": {
            "completed": len(records), "total": len(records), "percent": 100, "running_node_id": None}}
        if run.get("loops"):
            current["control_state"] = {"loops": list(run["loops"].values())}
        values = {
            "ok": True, "run_id": run["runId"], "status": run["status"], "version": run["version"],
            "current_result": current,
            "next_action": {"kind": "none", "reason":
                            "recipe-completed" if run["status"] == "completed" else "recipe-failed"},
            "replayed": False,
        }
        if run.get("automation"):
            values["automation"] = run["automation"]
        if detail == "full":
            current["completed_nodes"] = [
                {"node_id": node["nodeId"],
                 "outcome": records[node["nodeId"]].get("outcome", records[node["nodeId"]]["state"]),
                 "result": records[node["nodeId"]].get("result"),
                 "error": records[node["nodeId"]].get("error")} for node in nodes]
            values["recipe"] = {"recipe_id": run["recipeId"], "revision": run["recipeRevision"],
                                "executable_digest": run["executableDigest"]}
            values["usage"] = _usage_summary(run)
        return _response(**values)
    except Exception as error:
        return _response(ok=False, error={"code": "recipe-run-get-failed", "message": str(error)})
