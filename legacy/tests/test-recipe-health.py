#!/usr/bin/env python3
import datetime
import importlib.util
import json
import pathlib
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_health", ROOT / "resources" / "recipe_health.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def run_fixture(classification, code, status="failed", **extra):
    run = {
        "runId": "recipe_run_" + classification.replace("-", "_"),
        "recipeId": "recipe_health_fixture",
        "recipeRevision": 7,
        "executableDigest": "digest-pinned",
        "status": status,
        "createdAt": "2026-09-01T00:00:00+00:00",
        "terminalAt": "2026-09-01T00:00:02+00:00",
        "definition": {"spec": {"completion": {"requiredNodes": ["work"]}}},
        "nodes": {
            "work": {
                "state": "succeeded" if status == "completed" else "failed",
                "outcome": "succeeded" if status == "completed" else "failed",
                "attempt": 1,
                "startedAt": "2026-09-01T00:00:00+00:00",
                "completedAt": "2026-09-01T00:00:02+00:00",
                "healthSignals": [{"code": code, "owner": classification}],
                "result": {"secret": "DO-NOT-PERSIST", "prompt": "private customer content"},
                "error": "credential=DO-NOT-PERSIST",
            }
        },
        "usage": {"records": []},
    }
    run.update(extra)
    return run


for expected, code, status in [
    ("healthy", "validation-passed", "completed"),
    ("environment-failure", "provider-unavailable", "failed"),
    ("input-failure", "invalid-input", "failed"),
    ("implementation-failure", "executor-defect", "failed"),
    ("recipe-friction", "ambiguous-instruction", "completed"),
    ("recipe-failure", "recipe-safety-violation", "failed"),
]:
    receipt = MODULE.compile_health_receipt(run_fixture(expected, code, status))
    assert receipt["classification"] == expected, (expected, receipt)
    assert receipt["schema"] == "pkm.recipe.run-health/v1"
    assert receipt["recipe"]["revision"] == 7
    assert receipt["recipe"]["executableDigest"] == "digest-pinned"


ambiguous = run_fixture("recipe-friction", "ambiguous-instruction", "completed")
ambiguous["nodes"]["work"]["healthSignals"][0]["confidence"] = "unknown"
ambiguous_receipt = MODULE.compile_health_receipt(ambiguous)
assert ambiguous_receipt["ambiguous"] is True

redacted = json.dumps(MODULE.compile_health_receipt(
    run_fixture("recipe-failure", "recipe-safety-violation")))
assert "DO-NOT-PERSIST" not in redacted
assert "private customer content" not in redacted
assert "credential" not in redacted

cancelled = run_fixture("implementation-failure", "cancelled")
cancelled["nodes"]["work"]["cancelled"] = True
cancelled_receipt = MODULE.compile_health_receipt(cancelled)
assert cancelled_receipt["nodeFacts"][0]["cancelled"] is True

stale = run_fixture("recipe-friction", "stale-node", "completed")
stale["nodes"]["work"]["progress"] = {"stale": True, "message": "DO-NOT-PERSIST"}
assert MODULE.compile_health_receipt(stale)["classification"] == "recipe-friction"

partial = run_fixture("healthy", "validation-passed", "completed")
partial["nodes"]["work"]["state"] = "running"
partial_receipt = MODULE.compile_health_receipt(partial)
assert partial_receipt["complete"] is False
assert partial_receipt["classification"] == "implementation-failure"
assert partial_receipt["ambiguous"] is True

healthy = MODULE.compile_health_receipt(run_fixture("healthy", "validation-passed", "completed"))
assert healthy["cost"]["measured"] == {}
assert healthy["cost"]["estimated"] == {}
assert healthy["cost"]["unknown"] == {"modelCalls": 0}
assert healthy["cost"]["derived"] == {}

with tempfile.TemporaryDirectory(prefix="pkm-recipe-health-") as temporary:
    state_path = pathlib.Path(temporary) / "health.json"
    first = MODULE.record_health_receipt(state_path, healthy)
    replay = MODULE.record_health_receipt(state_path, healthy)
    assert first["proposal_created"] is False
    assert replay["duplicate"] is True
    assert first["model_requests"] == replay["model_requests"] == 0
    assert first["reflection_requests"] == replay["reflection_requests"] == 0
    assert first["agent_requests"] == first["optimization_requests"] == first["redesign_requests"] == 0
    stored = json.loads(state_path.read_text())
    aggregate = stored["aggregates"][0]
    assert aggregate["counts"]["healthy"] == 1
    assert stored["candidateRequests"] == []

    for classification, code in [
        ("environment-failure", "provider-unavailable"),
        ("input-failure", "invalid-input"),
    ]:
        receipt = MODULE.compile_health_receipt(run_fixture(classification, code))
        result = MODULE.record_health_receipt(state_path, receipt)
        assert result["proposal_created"] is False
    assert json.loads(state_path.read_text())["candidateRequests"] == []

with tempfile.TemporaryDirectory(prefix="pkm-recipe-friction-") as temporary:
    state_path = pathlib.Path(temporary) / "health.json"
    for index in range(3):
        run = run_fixture("recipe-friction", "ambiguous-instruction", "completed")
        run["runId"] = "recipe_run_friction_" + str(index)
        result = MODULE.record_health_receipt(
            state_path, MODULE.compile_health_receipt(run),
            now="2026-09-02T00:00:0{}+00:00".format(index))
    assert result["proposal_created"] is True
    state = json.loads(state_path.read_text())
    assert len(state["candidateRequests"]) == 1
    candidate = state["candidateRequests"][0]
    assert candidate["schema"] == "pkm.recipe.candidate-request/v1"
    assert candidate["status"] == "queued"
    assert candidate["baseRecipe"] == {
        "recipeId": "recipe_health_fixture",
        "revision": 7,
        "executableDigest": "digest-pinned",
    }
    assert candidate["validationComparison"] == {"baseline": None, "candidate": None, "verdict": None}
    assert "DO-NOT-PERSIST" not in json.dumps(state)
    replay = MODULE.record_health_receipt(
        state_path, MODULE.compile_health_receipt(run),
        now="2026-09-02T00:00:04+00:00")
    assert replay["duplicate"] is True
    assert len(json.loads(state_path.read_text())["candidateRequests"]) == 1

    fourth = run_fixture("recipe-friction", "ambiguous-instruction", "completed")
    fourth["runId"] = "recipe_run_friction_4"
    cooldown = MODULE.record_health_receipt(
        state_path, MODULE.compile_health_receipt(fourth),
        now="2026-09-02T00:01:00+00:00")
    assert cooldown["proposal_created"] is False
    assert cooldown["suppressed_by"] == "active-candidate"

    state = json.loads(state_path.read_text())
    state["candidateRequests"][0]["status"] = "rejected"
    state_path.write_text(json.dumps(state))
    fifth = run_fixture("recipe-friction", "ambiguous-instruction", "completed")
    fifth["runId"] = "recipe_run_friction_5"
    cooldown = MODULE.record_health_receipt(
        state_path, MODULE.compile_health_receipt(fifth),
        now="2026-09-02T00:02:00+00:00")
    assert cooldown["proposal_created"] is False
    assert cooldown["suppressed_by"] == "cooldown"

for code in ("recipe-safety-violation", "incorrect-success"):
    with tempfile.TemporaryDirectory(prefix="pkm-recipe-immediate-") as temporary:
        state_path = pathlib.Path(temporary) / "health.json"
        run = run_fixture("recipe-failure", code)
        run["runId"] = "recipe_run_" + code
        receipt = MODULE.compile_health_receipt(run)
        result = MODULE.record_health_receipt(state_path, receipt)
        assert result["proposal_created"] is True
        replay = MODULE.record_health_receipt(state_path, receipt)
        assert replay["duplicate"] is True
        assert replay["candidate_request_id"] == result["candidate_request_id"]
        assert len(json.loads(state_path.read_text())["candidateRequests"]) == 1

for origin in ("recipe-evolution", "candidate-validation"):
    with tempfile.TemporaryDirectory(prefix="pkm-recipe-recursion-") as temporary:
        state_path = pathlib.Path(temporary) / "health.json"
        run = run_fixture("recipe-failure", "recipe-safety-violation", healthContext={"kind": origin})
        result = MODULE.record_health_receipt(state_path, MODULE.compile_health_receipt(run))
        assert result["proposal_created"] is False
        assert result["suppressed_by"] == "recursion-prevention"

with tempfile.TemporaryDirectory(prefix="pkm-recipe-retention-") as temporary:
    state_path = pathlib.Path(temporary) / "health.json"
    for index in range(215):
        run = run_fixture("healthy", "validation-passed", "completed")
        run["runId"] = "recipe_run_retention_{:03d}".format(index)
        MODULE.record_health_receipt(state_path, MODULE.compile_health_receipt(run))
    retained = json.loads(state_path.read_text())
    assert len(retained["receipts"]) == MODULE.RECEIPT_RETENTION
    assert len(retained["aggregates"][0]["recentEvidence"]) == MODULE.ROLLING_RUNS

print("Recipe health tests passed.")
