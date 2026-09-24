#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
register_recipe_tools = MODULE.register_recipe_tools
related_recipes = MODULE.related_recipes


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
    subscription_cache = store / "subscription-cache"
    subscribed_root = subscription_cache / "node-test" / "share-test"
    subscribed_recipe_dir = subscribed_root / "content" / "recipes" / "Operations" / "Deployment"
    subscribed_recipe_dir.mkdir(parents=True)
    subscribed_recipe = {
        **recipe, "recipeId": "recipe_subscribed", "name": "Subscribed Deployment",
        "description": "Deploy a shared release from another Broker.", "category": "Operations/Deployment",
        "executableDigest": hashlib.sha256(canonical(definition).encode("utf-8")).hexdigest(),
    }
    (subscribed_recipe_dir / "recipe_subscribed.json").write_text(
        json.dumps(subscribed_recipe), encoding="utf-8")
    (subscribed_root / "_subscription.json").write_text(json.dumps({
        "subscriptionId": "subscription-test", "alias": "Team Recipes", "brokerName": "Release Broker",
        "publisher": "Remote PKM", "nodeId": "node-test", "shareId": "share-test", "revision": 4,
    }), encoding="utf-8")

    reverse_links = related_recipes(store, "Coding/Verify", "skill")
    assert reverse_links[0]["recipe_id"] == "recipe_test", reverse_links
    assert reverse_links[0]["bindings"] == [{"node_id": "implement", "usage": "required"}], reverse_links
    assert related_recipes(store, "Coding/Missing", "skill") == []

    environments_registry = store / "environments" / "registry.json"
    environments_registry.parent.mkdir(parents=True)
    environments_registry.write_text(json.dumps([{
        "id": "runtime-test", "name": "Runtime test", "manager": "other",
        "python": sys.executable, "path": str(pathlib.Path(sys.executable).parent),
    }]), encoding="utf-8")
    mcp = FakeMcp()
    tools = register_recipe_tools(mcp, store, subscription_cache, environments_registry)
    assert set(tools) == {"recipe_capabilities", "recipe_search", "recipe_create_from_skill", "recipe_run_start", "recipe_run_start_adhoc",
                          "recipe_run_get", "recipe_run_next", "recipe_run_report", "recipe_run_submit_input"}

    capabilities = json.loads(tools["recipe_capabilities"]())
    assert capabilities["proactive"] is True
    assert capabilities["next_tool"] == "recipe_search"
    assert "substantial multi-step task" in capabilities["use_when"]
    assert capabilities["execution"]["next_is_claim"] is True
    assert capabilities["version"] == "1.4.0"
    assert capabilities["execution"]["dynamic_v2"] is True
    assert capabilities["execution"]["strategy"] == "persisted-control-state-machine"
    assert capabilities["execution"]["supported_controls"] == [
        "branch", "bounded-loop", "pinned-subrecipe", "background-command", "mandatory-human-gate"]
    assert capabilities["design_persistence"].startswith("recipe_create_from_skill")
    assert capabilities["subscribed_recipes"].startswith("read-only")

    found = json.loads(tools["recipe_search"](query="implement", category="Software Development"))
    assert found["outcome"] == "candidates" and found["candidates"][0]["recipe_id"] == "recipe_test", found
    assert found["next_action"]["kind"] == "qualify_recipe"
    subscribed_found = json.loads(tools["recipe_search"](query="subscribed deployment"))
    subscribed_candidate = subscribed_found["candidates"][0]
    assert subscribed_candidate["original_recipe_id"] == "recipe_subscribed"
    assert subscribed_candidate["read_only"] is True and subscribed_candidate["requires_fork"] is True
    assert subscribed_candidate["provenance"]["brokerName"] == "Release Broker"
    assert subscribed_candidate["pkm_path"].endswith("/recipes/Operations/Deployment/recipe_subscribed.json")
    assert subscribed_found["next_action"]["kind"] == "review_subscribed_recipe"
    metadata_found = json.loads(tools["recipe_search"](query="actionable findings"))
    assert metadata_found["candidates"][0]["metadata"]["required_inputs"][0]["name"] == "diff", metadata_found
    missing = json.loads(tools["recipe_search"](query="unrelated", task_contract_json='{"goal":"new flow"}'))
    assert missing["outcome"] == "no-match" and missing["next_action"]["kind"] == "design_recipe", missing
    assert missing["next_action"]["task_contract"]["goal"] == "new flow"

    created = json.loads(tools["recipe_create_from_skill"](
        "Verify Changes", json.dumps(definition), "create-from-skill", "Coding/Verify", binding_hash,
        "Run a reusable validation workflow.", "Software Development"))
    assert created["ok"] and created["outcome"] == "recipe-created" and created["replayed"] is False, created
    created_id = created["recipe"]["recipe_id"]
    created_recipe = next(item for item in MODULE._project_recipes(store) if item["recipeId"] == created_id)
    assert created_recipe["origin"] == {"kind": "skill-recipe-gap", "skillId": "Coding/Verify"}
    assert created_recipe["nodeBindings"][0]["bindings"][0]["knowledgeId"] == "Coding/Verify"
    replayed_create = json.loads(tools["recipe_create_from_skill"](
        "Verify Changes", json.dumps(definition), "create-from-skill", "Coding/Verify", binding_hash,
        "Run a reusable validation workflow.", "Software Development"))
    assert replayed_create["replayed"] is True and replayed_create["recipe"]["recipe_id"] == created_id

    adhoc = json.loads(tools["recipe_run_start_adhoc"](
        "One-off implementation", json.dumps(recipe["definition"]), "adhoc-start", '{"request":"once"}'))
    assert adhoc["ok"] and adhoc["recipe"]["recipe_id"].startswith("adhoc_recipe_"), adhoc
    adhoc_run = json.loads((state_dir / "recipe-runs" / f"{adhoc['run_id']}.json").read_text())
    assert adhoc_run["recipeName"] == "One-off implementation"
    assert adhoc_run["origin"] == {"kind": "agent-session-adhoc"}
    assert recipe["recipeId"] != adhoc["recipe"]["recipe_id"]

    started = json.loads(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                    expected_revision=3, expected_digest="digest-test"))
    assert started["ok"] and started["next_action"]["kind"] == "call_recipe_run_next", started
    assert started["current_result"]["progress"] == {"completed": 0, "total": 2, "percent": 0,
                                                        "running_node_id": None}
    run_id = started["run_id"]
    replayed_start = json.loads(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                             expected_revision=3, expected_digest="digest-test"))
    assert replayed_start["replayed"] is True and replayed_start["run_id"] == run_id

    claimed = json.loads(tools["recipe_run_next"](run_id, "next-understand"))
    assert claimed["next_action"]["kind"] == "execute_node"
    assert claimed["next_action"]["node_id"] == "understand"
    assert claimed["current_result"]["progress"]["running_node_id"] == "understand"
    assert claimed["next_action"]["knowledge_bindings"] == []
    while_running = json.loads(tools["recipe_run_get"](run_id))
    assert while_running["next_action"]["kind"] == "report_node"

    advanced = json.loads(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert advanced["next_action"]["kind"] == "execute_node"
    assert advanced["next_action"]["node_id"] == "implement"
    assert advanced["current_result"]["progress"] == {"completed": 1, "total": 2, "percent": 50,
                                                         "running_node_id": "implement"}
    assert advanced["next_action"]["knowledge_bindings"][0]["knowledgeId"] == "Coding/Verify"
    assert advanced["next_action"]["knowledge_bindings"][0]["contentHash"] == binding_hash
    replayed_report = json.loads(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert replayed_report["replayed"] is True and replayed_report["next_action"]["node_id"] == "implement"

    completed = json.loads(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "report-implement", '{"artifact":"diff"}'))
    assert completed["status"] == "completed" and completed["next_action"]["kind"] == "none", completed
    assert completed["current_result"]["counts"] == {"pending": 0, "running": 0, "succeeded": 2, "failed": 0}
    assert completed["current_result"]["progress"] == {"completed": 2, "total": 2, "percent": 100,
                                                          "running_node_id": None}
    assert completed["current_result"]["completed_nodes"][-1]["result"]["artifact"] == "diff"

    automated_definition = {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
            "inputs": {},
            "nodes": [
                {"nodeId": "permission", "kind": "pkm.gate.human/v1", "config": {
                    "prompt": "May the Recipe execute the local module?", "inputKind": "approval"
                }, "dependsOn": []},
                {"nodeId": "execute", "kind": "pkm.step.command/v1", "config": {
                    "program": sys.executable,
                    "args": ["-c", "import sys; print('downloaded:' + sys.argv[1])", "${inputs.logId}"],
                    "timeoutSeconds": 10, "maxOutputBytes": 4096
                }, "dependsOn": [{"from": "permission", "accept": ["approved"], "required": True}]},
            ],
            "outputs": {},
            "completion": {"requiredNodes": ["execute"]},
        },
    }
    automated = json.loads(tools["recipe_run_start_adhoc"](
        "Approved background module", json.dumps(automated_definition), "automated-start", '{"logId":"run-42"}'))
    automated_id = automated["run_id"]
    gate = json.loads(tools["recipe_run_next"](automated_id, "claim-gate"))
    assert gate["next_action"]["kind"] == "request_user_input", gate
    assert gate["next_action"]["required"] is True
    assert gate["next_action"]["submit_tool"] == "recipe_run_submit_input"
    challenge_id = gate["next_action"]["challenge_id"]
    bypass = json.loads(tools["recipe_run_report"](
        automated_id, "permission", "approved", "bypass-gate", '{"approved":true}'))
    assert bypass["ok"] is False and "dedicated runtime adapter" in bypass["error"]["message"], bypass
    invalid_input = json.loads(tools["recipe_run_submit_input"](
        automated_id, "permission", challenge_id, '{}', "missing-approval"))
    assert invalid_input["ok"] is False and "explicit boolean" in invalid_input["error"]["message"]
    approved = json.loads(tools["recipe_run_submit_input"](
        automated_id, "permission", challenge_id, '{"approved":true,"comment":"Proceed"}', "approve-gate"))
    assert approved["next_action"]["kind"] == "wait_for_background", approved
    assert approved["next_action"]["command"]["args"][-1] == "run-42"
    assert "-c" in approved["next_action"]["command"]["args"]
    final_automated = approved
    for _ in range(100):
        final_automated = json.loads(tools["recipe_run_get"](automated_id))
        if final_automated["status"] != "running":
            break
        time.sleep(0.02)
    assert final_automated["status"] == "completed", final_automated
    command_result = final_automated["current_result"]["completed_nodes"][-1]["result"]
    assert command_result["exit_code"] == 0 and command_result["stdout"] == "downloaded:run-42\n", command_result
    assert command_result["stdout_truncated"] is False and command_result["timed_out"] is False

    def run_script(runtime, script, command_prefix, environment_id=None):
        config = {"runtime": runtime, "script": script, "timeoutSeconds": 10, "maxOutputBytes": 4096}
        if environment_id is not None:
            config["environmentId"] = environment_id
        script_definition = {
            "schema": "pkm.workflow.definition/v1",
            "spec": {"inputs": {}, "nodes": [{
                "nodeId": "execute", "kind": "pkm.step.script/v1", "config": config, "dependsOn": [],
            }], "outputs": {}, "completion": {"requiredNodes": ["execute"]}},
        }
        started_script = json.loads(tools["recipe_run_start_adhoc"](
            command_prefix, json.dumps(script_definition), command_prefix + "-start", '{}'))
        claimed_script = json.loads(tools["recipe_run_next"](
            started_script["run_id"], command_prefix + "-claim"))
        assert claimed_script["next_action"]["kind"] == "wait_for_background", claimed_script
        final_script = claimed_script
        for _ in range(100):
            final_script = json.loads(tools["recipe_run_get"](started_script["run_id"]))
            if final_script["status"] != "running":
                break
            time.sleep(0.02)
        return final_script

    python_script = run_script("python", "print('selected-pkm-environment')", "python-script", "runtime-test")
    assert python_script["status"] == "completed", python_script
    python_result = python_script["current_result"]["completed_nodes"][-1]["result"]
    assert python_result["argv"][0] == sys.executable, python_result
    assert python_result["stdout"] == "selected-pkm-environment\n", python_result
    assert not pathlib.Path(python_result["argv"][-1]).exists(), python_result

    missing_environment = run_script("python", "print('must not run')", "missing-environment", "deleted-env")
    assert missing_environment["status"] == "failed", missing_environment
    missing_result = missing_environment["current_result"]["completed_nodes"][-1]["result"]
    assert "not registered: deleted-env" in missing_result["error"], missing_result

    if os.name != "nt":
        bash_script = run_script("bash", "printf 'bash-script\\n'", "bash-script")
        assert bash_script["status"] == "completed", bash_script
        assert bash_script["current_result"]["completed_nodes"][-1]["result"]["stdout"] == "bash-script\n"
        powershell_script = run_script("powershell", "Write-Output 'must not run'", "powershell-script")
        assert powershell_script["status"] == "failed", powershell_script
        powershell_result = powershell_script["current_result"]["completed_nodes"][-1]["result"]
        assert "supported only on Windows" in powershell_result["error"], powershell_result

print("Recipe MCP runtime: discovery, lazy claims, command/script adapters, mandatory input, results, and replay OK")