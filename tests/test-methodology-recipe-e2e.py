#!/usr/bin/env python3
import concurrent.futures
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class FakeMcp:
    def __init__(self):
        self.tools = {}

    def tool(self):
        def decorate(function):
            self.tools[function.__name__] = function
            return function
        return decorate


recipe_json = subprocess.run(
    [
        "node",
        "-e",
        (
            "const {initializeProjectModel}=require('./dist/workflows/project-model.js');"
            "const state=initializeProjectModel(undefined,()=> 'methodology-e2e');"
            "const recipe=state.recipes.find(item=>item.name==='Configurable Validation and Testing');"
            "const universal=state.recipes.find(item=>item.name==='Universal Unknown Task');"
            "process.stdout.write(JSON.stringify({recipe,universal}));"
        ),
    ],
    cwd=ROOT,
    check=True,
    capture_output=True,
    text=True,
).stdout
built_ins = json.loads(recipe_json)
recipe = built_ins["recipe"]
universal = built_ins["universal"]
assert recipe["methodology"]["family"] == "validation-and-testing"
assert recipe["methodology"]["invariants"].count("coverage-is-not-acceptance") == 1

with tempfile.TemporaryDirectory(prefix="pkm-methodology-e2e-") as temporary:
    store = pathlib.Path(temporary)
    state_dir = store / ".pkm" / "state"
    state_dir.mkdir(parents=True)
    payload = {
        "state": {
            "schema": 1,
            "rootId": "root_methodology_e2e",
            "projects": [],
            "threads": [],
            "recipes": [recipe, universal],
            "migrations": [],
            "audit": [],
        },
        "receipts": [],
    }
    envelope = {
        "schema": 1,
        "storeVersion": 1,
        "payload": payload,
        "digest": hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest(),
    }
    (state_dir / "projects.json").write_text(canonical(envelope), encoding="utf-8")

    first_mcp = FakeMcp()
    tools = RUNTIME.register_recipe_tools(first_mcp, store)
    family_fallback = json.loads(tools["recipe_search"](
        query="no-exact-match", task_contract_json='{"family":"validation-and-testing"}'))
    assert family_fallback["outcome"] == "family-fallback"
    assert family_fallback["candidates"][0]["recipe_id"] == recipe["recipeId"]
    universal_fallback = json.loads(tools["recipe_search"](
        query="no-exact-match", task_contract_json='{"goal":"unknown"}'))
    assert universal_fallback["outcome"] == "universal-fallback"
    assert universal_fallback["candidates"][0]["recipe_id"] == universal["recipeId"]
    invalid = json.loads(tools["recipe_run_start"](
        recipe["recipeId"], "methodology-e2e-invalid", '{"riskProfile":"file-safety"}',
        expected_revision=recipe["revision"], expected_digest=recipe["executableDigest"]))
    assert not invalid["ok"]
    assert "is required" in invalid["error"]["message"], invalid

    inputs = {
        "taskContract": {"evidenceId": "task-contract-1", "digest": "task-contract-digest"},
        "riskProfile": "file-safety",
        "assuranceLevel": "high-assurance",
        "changedSurfaces": ["runtime", "ui", "persistence", "agent-collaboration"],
        "requestedModules": ["ui", "security", "simulation", "recovery", "concurrency", "agent-collaboration", "full-e2e"],
        "environments": ["linux", "vscode-webview", "standalone-browser"],
        "recoveryRequired": True,
        "timeBudgetMinutes": "90",
        "maxRetries": "1",
    }
    def concurrent_start():
        return json.loads(tools["recipe_run_start"](
            recipe["recipeId"], "methodology-e2e-concurrent", json.dumps(inputs),
            expected_revision=recipe["revision"], expected_digest=recipe["executableDigest"]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        concurrent_results = list(executor.map(lambda _index: concurrent_start(), range(2)))
    assert all(result["ok"] for result in concurrent_results), concurrent_results
    assert sorted(result["replayed"] for result in concurrent_results) == [False, True], concurrent_results
    changed_inputs = {**inputs, "riskProfile": "standard"}
    command_reuse = json.loads(tools["recipe_run_start"](
        recipe["recipeId"], "methodology-e2e-concurrent", json.dumps(changed_inputs),
        expected_revision=recipe["revision"], expected_digest=recipe["executableDigest"]))
    assert not command_reuse["ok"] and "reused with different parameters" in command_reuse["error"]["message"], command_reuse

    started = json.loads(tools["recipe_run_start"](
        recipe["recipeId"], "methodology-e2e-valid", json.dumps(inputs),
        expected_revision=recipe["revision"], expected_digest=recipe["executableDigest"]))
    assert started["ok"] and started["next_action"]["kind"] == "call_recipe_run_next", started
    run_id = started["run_id"]
    selected = {"ui", "security", "simulation", "recovery", "concurrency", "agent-collaboration", "full-e2e"}
    executed = []
    response = json.loads(tools["recipe_run_next"](run_id, "methodology-e2e-next-0"))
    command_index = 1
    restarted = False

    while response["next_action"]["kind"] != "none":
        action = response["next_action"]
        if action["kind"] == "call_recipe_run_next":
            response = json.loads(tools["recipe_run_next"](
                run_id, f"methodology-e2e-next-{command_index}"))
            command_index += 1
            continue
        assert action["kind"] == "execute_node", action
        node_id = action["node_id"]
        executed.append(node_id)
        if node_id.startswith("select-"):
            module_id = node_id.removeprefix("select-")
            outcome = "include" if module_id in selected else "skip"
            result = {"module": module_id, "decision": outcome, "reason": "risk-profile-policy"}
        else:
            outcome = "succeeded"
            result = {
                "node": node_id,
                "evidence": "reproducible",
                "coverageOnly": False,
            }
        if node_id == "select-security" and not restarted:
            restarted = True
            resumed_mcp = FakeMcp()
            tools = RUNTIME.register_recipe_tools(resumed_mcp, store)
            resumed = json.loads(tools["recipe_run_get"](run_id))
            assert resumed["next_action"]["kind"] == "report_node"
            assert resumed["next_action"]["node_id"] == "select-security"
        response = json.loads(tools["recipe_run_report"](
            run_id, node_id, outcome, f"methodology-e2e-report-{command_index}",
            json.dumps(result)))
        command_index += 1

    assert response["status"] == "completed", response
    assert "compile-test-matrix" in executed
    assert "test-ui" in executed and "test-security" in executed and "test-simulation" in executed
    assert "test-recovery" in executed and "test-concurrency" in executed
    assert "test-agent-collaboration" in executed and "test-full-e2e" in executed
    assert "test-performance" not in executed
    assert executed[-1] == "independent-acceptance"

    run = json.loads((state_dir / "recipe-runs" / f"{run_id}.json").read_text(encoding="utf-8"))
    assert run["inputs"]["timeBudgetMinutes"] == "90"
    assert run["inputs"]["maxRetries"] == "1"
    assert run["nodes"]["test-performance"]["state"] == "skipped"
    assert run["nodes"]["test-performance"]["error"] == "Dependency outcome did not select this path."
    assert run["nodes"]["test-full-e2e"]["state"] == "succeeded"
    assert run["nodes"]["independent-acceptance"]["result"]["coverageOnly"] is False

print("Methodology Recipe E2E: typed configuration, adaptive modules, restart recovery, and acceptance OK")
