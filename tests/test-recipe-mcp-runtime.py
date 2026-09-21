#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import pathlib
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
register_recipe_tools = MODULE.register_recipe_tools


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


with tempfile.TemporaryDirectory(prefix="pkm-recipe-runtime-") as temporary:
    store = pathlib.Path(temporary)
    state_dir = store / ".pkm" / "state"
    state_dir.mkdir(parents=True)
    definition = {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
            "inputs": {},
            "nodes": [
                {"nodeId": "understand", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []},
                {"nodeId": "implement", "kind": "pkm.step.noop/v1", "config": {},
                 "dependsOn": [{"from": "understand", "accept": ["succeeded"], "required": True}]},
            ],
            "outputs": {},
            "completion": {"requiredNodes": ["implement"]},
        },
    }
    binding_hash = hashlib.sha256(b"Run focused validation.").hexdigest()
    recipe = {
        "recipeId": "recipe_test", "scope": "global", "category": "Software Development",
        "name": "Test Development", "description": "Understand and implement a tested change.",
        "metadata": {
            "applicableFunctions": ["Release review"], "solution": "Inspect a patch and verify delivery.",
            "requiredInputs": [{"name": "diff", "description": "The source patch", "required": True}],
            "expectedOutputs": [{"name": "review", "description": "Actionable findings"}],
        },
        "definition": definition, "executableDigest": "digest-test", "revision": 3,
        "nodeBindings": [{"nodeId": "implement", "bindings": [{
            "bindingId": "verify", "kind": "skill", "knowledgeId": "Coding/Verify",
            "contentHash": binding_hash, "usage": "required"
        }]}],
    }
    payload = {"state": {"schema": 1, "rootId": "root_test", "projects": [], "threads": [],
                         "recipes": [recipe], "migrations": [], "audit": []}, "receipts": []}
    envelope = {"schema": 1, "storeVersion": 1, "payload": payload,
                "digest": hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()}
    (state_dir / "projects.json").write_text(canonical(envelope), encoding="utf-8")

    mcp = FakeMcp()
    tools = register_recipe_tools(mcp, store)
    assert set(tools) == {"recipe_capabilities", "recipe_search", "recipe_run_start", "recipe_run_get",
                          "recipe_run_next", "recipe_run_report"}

    capabilities = json.loads(tools["recipe_capabilities"]())
    assert capabilities["execution"]["next_is_claim"] is True
    assert capabilities["execution"]["dynamic_v2"] is False
    assert capabilities["design_persistence"].startswith("unavailable")

    found = json.loads(tools["recipe_search"](query="implement", category="Software Development"))
    assert found["outcome"] == "candidates" and found["candidates"][0]["recipe_id"] == "recipe_test", found
    assert found["next_action"]["kind"] == "qualify_recipe"
    metadata_found = json.loads(tools["recipe_search"](query="actionable findings"))
    assert metadata_found["candidates"][0]["metadata"]["required_inputs"][0]["name"] == "diff", metadata_found
    missing = json.loads(tools["recipe_search"](query="unrelated", task_contract_json='{"goal":"new flow"}'))
    assert missing["outcome"] == "no-match" and missing["next_action"]["kind"] == "design_recipe", missing
    assert missing["next_action"]["task_contract"]["goal"] == "new flow"

    started = json.loads(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                    expected_revision=3, expected_digest="digest-test"))
    assert started["ok"] and started["next_action"]["kind"] == "call_recipe_run_next", started
    run_id = started["run_id"]
    replayed_start = json.loads(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                             expected_revision=3, expected_digest="digest-test"))
    assert replayed_start["replayed"] is True and replayed_start["run_id"] == run_id

    claimed = json.loads(tools["recipe_run_next"](run_id, "next-understand"))
    assert claimed["next_action"]["kind"] == "execute_node"
    assert claimed["next_action"]["node_id"] == "understand"
    assert claimed["next_action"]["knowledge_bindings"] == []
    while_running = json.loads(tools["recipe_run_get"](run_id))
    assert while_running["next_action"]["kind"] == "report_node"

    advanced = json.loads(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert advanced["next_action"]["kind"] == "execute_node"
    assert advanced["next_action"]["node_id"] == "implement"
    assert advanced["next_action"]["knowledge_bindings"][0]["knowledgeId"] == "Coding/Verify"
    assert advanced["next_action"]["knowledge_bindings"][0]["contentHash"] == binding_hash
    replayed_report = json.loads(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert replayed_report["replayed"] is True and replayed_report["next_action"]["node_id"] == "implement"

    completed = json.loads(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "report-implement", '{"artifact":"diff"}'))
    assert completed["status"] == "completed" and completed["next_action"]["kind"] == "none", completed
    assert completed["current_result"]["counts"] == {"pending": 0, "running": 0, "succeeded": 2, "failed": 0}
    assert completed["current_result"]["completed_nodes"][-1]["result"]["artifact"] == "diff"

print("Recipe MCP runtime: search, design fallback, lazy claims, results, and replay OK")