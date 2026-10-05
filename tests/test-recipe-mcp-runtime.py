#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import types
from concurrent.futures import ThreadPoolExecutor


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
register_recipe_tools = MODULE.register_recipe_tools
related_recipes = MODULE.related_recipes

original_runtime_os = MODULE.os
MODULE.os = types.SimpleNamespace(name="nt")
windows_background_flags = MODULE._background_process_options()["creationflags"]
assert windows_background_flags & 0x08000000
assert windows_background_flags & 0x00000200
assert MODULE._hidden_process_options()["creationflags"] & 0x08000000
MODULE.os = original_runtime_os


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def response_value(value):
    return json.loads(value) if isinstance(value, str) else value


receipt_run = {"receipts": {}}
large_marker = "RECEIPT-RESULT-MUST-NOT-BE-DUPLICATED-" + ("x" * 32768)
large_response = canonical({
    "ok": True,
    "current_result": {
        "completed_nodes": [{
            "node_id": "work", "outcome": "succeeded",
            "result": {"artifact": large_marker}, "error": "",
        }],
        "counts": {"succeeded": 1},
        "progress": {"completed": 1, "total": 1, "percent": 100},
    },
    "next_action": {"kind": "none"},
})
for index in range(40):
    MODULE._store_receipt(
        receipt_run, f"receipt-{index}", f"fingerprint-{index}", large_response)
stored_receipts = canonical(receipt_run["receipts"])
assert large_marker not in stored_receipts
assert len(stored_receipts.encode("utf-8")) <= MODULE.RECEIPT_BYTE_LIMIT
replayed_receipt = json.loads(MODULE._receipt(
    receipt_run, "receipt-39", "fingerprint-39"))
assert replayed_receipt["replayed"] is True
assert replayed_receipt["current_result"]["completed_nodes"][0]["result_omitted"] is True


class FakeMcp:
    def __init__(self):
        self.tools = {}
        self.annotations = {}

    def tool(self, annotations=None):
        def decorate(function):
            self.tools[function.__name__] = function
            self.annotations[function.__name__] = annotations
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
        "methodology": {
            "schema": "pkm.recipe.methodology/v1",
            "family": "validation-and-testing",
            "phase": "validation",
            "abstract": False,
            "mixins": [],
            "capabilities": ["evidence-validation"],
            "artifacts": {"inputs": ["task-contract"], "outputs": ["evidence-bundle"]},
            "gates": ["independent-acceptance"],
            "invariants": ["coverage-is-not-acceptance"],
            "expansion": {"signals": ["risk"], "minimumDepth": 1, "maximumDepth": 4},
            "communication": {"minimumAssurance": "structured-acknowledgement"},
            "retrieval": {
                "intents": ["validate a complete user journey"],
                "terminology": ["behavior-first testing", "acceptance gate"],
                "operationalPoints": ["browser interaction", "runtime recovery"],
            },
        },
        "methodologyDigest": "methodology-digest-test",
        "definition": definition, "executableDigest": "digest-test", "revision": 3,
        "nodeBindings": [{"nodeId": "implement", "bindings": [{
            "bindingId": "verify", "kind": "skill", "knowledgeId": "Coding/Verify",
            "contentHash": binding_hash, "usage": "required"
        }]}],
    }
    native_definition = {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
            "inputs": {
                "reason": {"type": "string", "default": "manual"},
                "stateJson": {"type": "string", "default": ""},
            },
            "nodes": [{
                "nodeId": "create-snapshot", "kind": "pkm.step.native/v1",
                "config": {
                    "operation": "agent_session_snapshot_create",
                    "arguments": {
                        "reason": "${inputs.reason}",
                        "state_json": "${inputs.stateJson}",
                    },
                },
                "dependsOn": [],
            }],
            "outputs": {},
            "completion": {"requiredNodes": ["create-snapshot"]},
        },
    }
    native_digest = hashlib.sha256(canonical(native_definition).encode("utf-8")).hexdigest()
    native_recipe = {
        "recipeId": "recipe_snapshot_builtin", "scope": "global",
        "category": "System/PKM/Agent Sessions", "systemKind": "built-in",
        "name": "Create Agent Snapshot",
        "description": "Create an immutable recovery point for the active Agent Session.",
        "metadata": {
            "applicableFunctions": ["Create Agent Snapshot", "Generate Agent Snapshot"],
            "solution": "Create a Snapshot without model-executed steps.",
            "requiredInputs": [],
            "expectedOutputs": [{"name": "recoveryPrompt", "description": "Reusable Magic Code prompt"}],
        },
        "definition": native_definition, "executableDigest": native_digest, "revision": 2,
    }
    payload = {"state": {"schema": 1, "rootId": "root_test", "projects": [], "threads": [],
                         "recipes": [recipe, native_recipe], "migrations": [], "audit": []}, "receipts": []}
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
    native_calls = []

    def create_snapshot(reason, state_json, ctx=None):
        native_calls.append({"reason": reason, "state_json": state_json, "ctx": ctx})
        return {
            "ok": True,
            "snapshot": {"snapshotId": "agent_snapshot_test", "magicCode": "PKM-SNAP-TEST"},
            "recovery_prompt": "Recover PKM Agent Snapshot PKM-SNAP-TEST.",
            "warning": "Local obfuscation only.",
        }

    tools = register_recipe_tools(mcp, store, subscription_cache, environments_registry, {
        "agent_session_snapshot_create": {
            "handler": create_snapshot,
            "ephemeral_fields": [],
            "recipe_id": native_recipe["recipeId"],
            "revision": native_recipe["revision"],
            "executable_digest": native_recipe["executableDigest"],
        },
    })
    for tool_name in ("recipe_capabilities", "recipe_usage_summary", "recipe_search", "recipe_run_get"):
        assert mcp.annotations[tool_name] == {"readOnlyHint": True}, (
            tool_name, mcp.annotations[tool_name])
    assert set(tools) == {"recipe_capabilities", "recipe_search", "recipe_create_from_skill", "recipe_run_start", "recipe_run_start_adhoc",
                          "recipe_run_get", "recipe_run_next", "recipe_run_progress", "recipe_run_report",
                          "recipe_run_submit_input", "recipe_usage_summary"}

    capabilities = response_value(tools["recipe_capabilities"]())
    assert capabilities["proactive"] is True
    assert capabilities["next_tool"] == "recipe_search"
    assert "branching or bounded repetition" in capabilities["use_when"]
    assert "validated reusable solution, including mature linear Recipes" in capabilities["use_when"]
    assert "one-node noop tracking" in capabilities["do_not_use_when"]
    assert "linear inspect-edit-validate work" not in capabilities["do_not_use_when"]
    assert capabilities["execution"]["next_is_claim"] is True
    assert capabilities["execution"]["parallel_agent_claims"] is False
    assert capabilities["execution"]["autonomous_run_scheduler"] is True
    assert capabilities["execution"]["autonomous_execution"]["strategy"] == "serial-worker-completion-driven"
    assert capabilities["execution"]["automatic_model_escalation"] is False
    assert capabilities["version"] == "1.8.0"
    assert "recipe_usage_summary" in capabilities["tools"]
    assert capabilities["usage_accounting"]["measured_and_estimated_are_separate"] is True
    assert capabilities["usage_accounting"]["host_tokens"].startswith("unknown")
    assert capabilities["run_health"]["receipt_schema"] == "pkm.recipe.run-health/v1"
    assert capabilities["run_health"]["healthy_path_model_calls"] == 0
    assert capabilities["execution"]["dynamic_v2"] is True
    assert capabilities["execution"]["strategy"] == "persisted-control-state-machine"
    assert capabilities["execution"]["supported_controls"] == [
        "branch", "bounded-loop", "pinned-subrecipe", "background-command", "mandatory-human-gate",
        "built-in-native-operation"]
    assert capabilities["execution"]["native_operations"]["registered"] == [
        "agent_session_snapshot_create"]
    assert capabilities["design_persistence"].startswith("recipe_create_from_skill")
    assert capabilities["subscribed_recipes"].startswith("read-only")

    found = response_value(tools["recipe_search"](query="implement", category="Software Development"))
    assert found["outcome"] == "candidates" and found["candidates"][0]["recipe_id"] == "recipe_test", found
    assert found["next_action"]["kind"] == "qualify_recipe"
    subscribed_found = response_value(tools["recipe_search"](query="subscribed deployment"))
    subscribed_candidate = subscribed_found["candidates"][0]
    assert subscribed_candidate["original_recipe_id"] == "recipe_subscribed"
    assert subscribed_candidate["read_only"] is True and subscribed_candidate["requires_fork"] is True
    assert subscribed_candidate["provenance"]["brokerName"] == "Release Broker"

    snapshot_found = response_value(tools["recipe_search"](query="generate agent snapshot"))
    assert snapshot_found["candidates"][0]["recipe_id"] == native_recipe["recipeId"], snapshot_found
    snapshot_started = response_value(tools["recipe_run_start"](
        native_recipe["recipeId"], "native-snapshot-start", '{"reason":"test"}',
        expected_revision=2, expected_digest=native_digest))
    snapshot_run_id = snapshot_started["run_id"]
    snapshot_result = response_value(tools["recipe_run_next"](
        snapshot_run_id, "native-snapshot-next", detail="full", ctx=object()))
    assert snapshot_result["status"] == "completed", snapshot_result
    assert snapshot_result["usage"]["measured_total_tokens"] == 0
    assert snapshot_result["usage"]["unknown_model_calls"] == 0
    assert "ephemeral_output" not in snapshot_result
    assert native_calls[0]["reason"] == "test" and native_calls[0]["state_json"] == ""
    persisted_native_run = (state_dir / "recipe-runs" / f"{snapshot_run_id}.json").read_text(encoding="utf-8")
    assert "recovery_passphrase" not in persisted_native_run
    assert "Recover PKM Agent Snapshot PKM-SNAP-TEST." in persisted_native_run
    replayed_snapshot = response_value(tools["recipe_run_next"](
        snapshot_run_id, "native-snapshot-next", detail="full", ctx=object()))
    assert replayed_snapshot["replayed"] is True
    assert "ephemeral_output" not in replayed_snapshot
    assert "Recover PKM Agent Snapshot PKM-SNAP-TEST." in json.dumps(replayed_snapshot)
    assert len(native_calls) == 1
    rejected_native = response_value(tools["recipe_run_start_adhoc"](
        "Untrusted native operation", json.dumps(native_definition), "native-adhoc", '{}'))
    assert rejected_native["ok"] is False
    assert "restricted to PKM built-in Recipes" in rejected_native["error"]["message"]
    assert subscribed_candidate["pkm_path"].endswith("/recipes/Operations/Deployment/recipe_subscribed.json")
    assert subscribed_found["next_action"]["kind"] == "review_subscribed_recipe"
    metadata_found = response_value(tools["recipe_search"](query="actionable findings"))
    assert metadata_found["candidates"][0]["metadata"]["required_inputs"][0]["name"] == "diff", metadata_found
    methodology_found = response_value(tools["recipe_search"](query="browser interaction acceptance gate"))
    methodology_candidate = next(item for item in methodology_found["candidates"] if item["recipe_id"] == "recipe_test")
    assert methodology_candidate["methodology"]["family"] == "validation-and-testing"
    assert methodology_candidate["methodology"]["retrieval"]["operationalPoints"] == [
        "browser interaction", "runtime recovery"]
    family_fallback = response_value(tools["recipe_search"](
        query="does-not-match-metadata", task_contract_json='{"family":"validation-and-testing"}'))
    assert family_fallback["outcome"] == "family-fallback", family_fallback
    assert any(item["recipe_id"] == "recipe_test" for item in family_fallback["candidates"])
    assert family_fallback["next_action"]["fallback"] == "family-fallback"
    missing = response_value(tools["recipe_search"](query="unrelated", task_contract_json='{"goal":"new flow"}'))
    assert missing["outcome"] == "no-match" and missing["next_action"]["kind"] == "design_recipe", missing
    assert missing["next_action"]["task_contract"]["goal"] == "new flow"

    created = response_value(tools["recipe_create_from_skill"](
        "Verify Changes", json.dumps(definition), "create-from-skill", "Coding/Verify", binding_hash,
        "Run a reusable validation workflow.", "Software Development"))
    assert created["ok"] and created["outcome"] == "recipe-created" and created["replayed"] is False, created
    created_id = created["recipe"]["recipe_id"]
    created_recipe = next(item for item in MODULE._project_recipes(store) if item["recipeId"] == created_id)
    assert created_recipe["origin"] == {"kind": "skill-recipe-gap", "skillId": "Coding/Verify"}
    assert created_recipe["nodeBindings"][0]["bindings"][0]["knowledgeId"] == "Coding/Verify"
    replayed_create = response_value(tools["recipe_create_from_skill"](
        "Verify Changes", json.dumps(definition), "create-from-skill", "Coding/Verify", binding_hash,
        "Run a reusable validation workflow.", "Software Development"))
    assert replayed_create["replayed"] is True and replayed_create["recipe"]["recipe_id"] == created_id

    adhoc = response_value(tools["recipe_run_start_adhoc"](
        "One-off implementation", json.dumps(recipe["definition"]), "adhoc-start", '{"request":"once"}'))
    assert adhoc["ok"] and adhoc["recipe"]["recipe_id"].startswith("adhoc_recipe_"), adhoc
    adhoc_run = json.loads((state_dir / "recipe-runs" / f"{adhoc['run_id']}.json").read_text())
    assert adhoc_run["recipeName"] == "One-off implementation"
    assert adhoc_run["origin"] == {"kind": "agent-session-adhoc"}
    assert recipe["recipeId"] != adhoc["recipe"]["recipe_id"]

    typed_definition = {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
            "inputs": {
                "task": {"type": "string", "required": True},
                "attempts": {"type": "int64", "default": "3"},
                "threshold": {"type": "decimal", "default": "1.500"},
                "evidence": {"type": "artifact", "nullable": True},
                "policy": {
                    "type": "object",
                    "required": True,
                    "schema": {
                        "properties": {
                            "strict": {"type": "boolean", "required": True},
                            "labels": {
                                "type": "array",
                                "schema": {
                                    "items": {"type": "string"},
                                    "minItems": 1,
                                    "maxItems": 2,
                                },
                            },
                        },
                    },
                },
            },
            "nodes": [{"nodeId": "work", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []}],
            "outputs": {},
            "completion": {"requiredNodes": ["work"]},
        },
    }
    typed_missing = response_value(tools["recipe_run_start_adhoc"](
        "Typed inputs", json.dumps(typed_definition), "typed-missing", '{"policy":{"strict":true}}'))
    assert not typed_missing["ok"] and "/inputs/task is required" in typed_missing["error"]["message"], typed_missing
    typed_unknown = response_value(tools["recipe_run_start_adhoc"](
        "Typed inputs", json.dumps(typed_definition), "typed-unknown",
        '{"task":"verify","policy":{"strict":true},"surprise":1}'))
    assert not typed_unknown["ok"] and "unknown fields: surprise" in typed_unknown["error"]["message"], typed_unknown
    typed_invalid = response_value(tools["recipe_run_start_adhoc"](
        "Typed inputs", json.dumps(typed_definition), "typed-invalid",
        '{"task":"verify","attempts":3,"policy":{"strict":true,"labels":[]}}'))
    assert not typed_invalid["ok"] and "canonical int64 string" in typed_invalid["error"]["message"], typed_invalid
    typed_started = response_value(tools["recipe_run_start_adhoc"](
        "Typed inputs", json.dumps(typed_definition), "typed-valid",
        '{"task":"verify","policy":{"strict":true,"labels":["runtime"]},"evidence":null}'))
    assert typed_started["ok"], typed_started
    typed_run = json.loads((state_dir / "recipe-runs" / f"{typed_started['run_id']}.json").read_text())
    assert typed_run["inputs"] == {
        "attempts": "3",
        "evidence": None,
        "policy": {"labels": ["runtime"], "strict": True},
        "task": "verify",
        "threshold": "1.5",
    }, typed_run["inputs"]

    started = response_value(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                    expected_revision=3, expected_digest="digest-test"))
    assert started["ok"] and started["next_action"]["kind"] == "call_recipe_run_next", started
    assert "usage" not in started and "completed_nodes" not in started["current_result"]
    assert len(json.dumps(started, ensure_ascii=False).encode("utf-8")) < 1400
    assert started["current_result"]["progress"] == {"completed": 0, "total": 2, "percent": 0,
                                                        "running_node_id": None}
    run_id = started["run_id"]
    replayed_start = response_value(tools["recipe_run_start"]("recipe_test", "start-command", '{"request":"demo"}',
                                                             expected_revision=3, expected_digest="digest-test"))
    assert replayed_start["replayed"] is True and replayed_start["run_id"] == run_id

    claimed = response_value(tools["recipe_run_next"](run_id, "next-understand"))
    assert claimed["next_action"]["kind"] == "execute_node"
    assert claimed["next_action"]["node_id"] == "understand"
    assert claimed["current_result"]["progress"]["running_node_id"] == "understand"
    assert claimed["current_result"]["running_progress"]["progress"]["phase"] == "claimed"
    assert claimed["next_action"]["knowledge_bindings"] == []
    progress = response_value(tools["recipe_run_progress"](
        run_id, "understand", "progress-understand",
        json.dumps({
            "phase": "inspection", "message": "Reviewed 4 of 10 files.", "completed": 4, "total": 10,
            "etaSeconds": 30, "safeToInterrupt": True, "sideEffects": [],
            "staleAfterSeconds": 120, "events": [{"level": "info", "message": "Repository scan complete."}],
        })))
    assert progress["ok"] and progress["current_result"]["running_progress"]["progress"]["completed"] == 4
    assert progress["current_result"]["running_progress"]["progress"]["events"][0]["message"] == "Repository scan complete."
    assert progress["current_result"]["running_progress"]["observability"]["state"] == "active"
    progress_run_path = state_dir / "recipe-runs" / f"{run_id}.json"
    progress_run = json.loads(progress_run_path.read_text())
    last_progress_at = progress_run["nodes"]["understand"]["lastProgressAt"]
    progress_run["nodes"]["understand"]["lastProgressAt"] = "2026-01-01T00:00:00+00:00"
    progress_run_path.write_text(json.dumps(progress_run))
    heartbeat_only = response_value(tools["recipe_run_progress"](
        run_id, "understand", "heartbeat-understand",
        json.dumps({
            "phase": "inspection", "message": "Still processing the same bounded batch.",
            "safeToInterrupt": True, "staleAfterSeconds": 120, "progressed": False,
            "toolCallCount": 5, "currentValidation": "not-started",
        })))
    assert heartbeat_only["ok"]
    heartbeat_observability = heartbeat_only["current_result"]["running_progress"]["observability"]
    assert heartbeat_observability["state"] == "intervention-required", heartbeat_observability
    assert heartbeat_observability["recommended_action"] == "checkpoint-cancel-or-reassign"
    heartbeat_run = json.loads(progress_run_path.read_text())
    assert heartbeat_run["nodes"]["understand"]["lastProgressAt"] == "2026-01-01T00:00:00+00:00"
    assert heartbeat_run["nodes"]["understand"]["lastHeartbeatAt"] != last_progress_at
    waiting = response_value(tools["recipe_run_progress"](
        run_id, "understand", "waiting-understand",
        json.dumps({
            "phase": "waiting", "message": "Waiting for human approval.", "waitingOn": "human-gate",
            "safeToInterrupt": True, "staleAfterSeconds": 120, "progressed": False,
        })))
    assert waiting["current_result"]["running_progress"]["observability"]["state"] == "waiting"
    replayed_progress = response_value(tools["recipe_run_progress"](
        run_id, "understand", "progress-understand",
        json.dumps({
            "phase": "inspection", "message": "Reviewed 4 of 10 files.", "completed": 4, "total": 10,
            "etaSeconds": 30, "safeToInterrupt": True, "sideEffects": [],
            "staleAfterSeconds": 120, "events": [{"level": "info", "message": "Repository scan complete."}],
        })))
    assert replayed_progress["replayed"] is True
    invalid_progress = response_value(tools["recipe_run_progress"](
        run_id, "understand", "progress-invalid", '{"surprise":true}'))
    assert not invalid_progress["ok"] and "unknown fields" in invalid_progress["error"]["message"]
    while_running = response_value(tools["recipe_run_get"](run_id))
    assert while_running["next_action"]["kind"] == "report_node"

    advanced = response_value(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert "usage" not in advanced and "completed_nodes" not in advanced["current_result"]
    assert advanced["next_action"]["kind"] == "execute_node"
    assert advanced["next_action"]["node_id"] == "implement"
    assert advanced["current_result"]["progress"] == {"completed": 1, "total": 2, "percent": 50,
                                                         "running_node_id": "implement"}
    assert advanced["next_action"]["knowledge_bindings"][0]["knowledgeId"] == "Coding/Verify"
    assert advanced["next_action"]["knowledge_bindings"][0]["contentHash"] == binding_hash
    replayed_report = response_value(tools["recipe_run_report"](
        run_id, "understand", "succeeded", "report-understand", '{"summary":"clear"}'))
    assert replayed_report["replayed"] is True and replayed_report["next_action"]["node_id"] == "implement"

    invalid_usage = response_value(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "invalid-usage", '{"artifact":"diff"}', "",
        '{"measured_tokens":{"input_tokens":true}}'))
    assert invalid_usage["ok"] is False and "non-negative integer" in invalid_usage["error"]["message"]
    unknown_usage_field = response_value(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "invalid-usage-field", '{"artifact":"diff"}', "",
        '{"unknown_model_calls":1,"host_tokens":12}'))
    assert unknown_usage_field["ok"] is False and "unknown fields" in unknown_usage_field["error"]["message"]
    invalid_cached_tokens = response_value(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "invalid-cached-tokens", '{"artifact":"diff"}', "",
        json.dumps({
            "measured_tokens": {
                "input_tokens": 1, "output_tokens": 1, "cached_input_tokens": 2,
                "reasoning_tokens": 0, "total_tokens": 2,
            },
            "provider": "example-provider", "model": "example-model",
        })))
    assert invalid_cached_tokens["ok"] is False and "cannot exceed" in invalid_cached_tokens["error"]["message"]
    still_running = response_value(tools["recipe_run_get"](run_id))
    assert still_running["current_result"]["progress"]["running_node_id"] == "implement"

    reported_usage = {
        "measured_tokens": {
            "input_tokens": 120, "output_tokens": 30, "cached_input_tokens": 40,
            "reasoning_tokens": 10, "total_tokens": 160,
        },
        "estimated_tokens": 30,
        "unknown_model_calls": 1,
        "provider": "example-provider",
        "model": "example-model",
        "derived_cost": {"amount_micros": 12500, "currency": "USD", "price_version": "2026-09"},
    }
    completed = response_value(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "report-implement", '{"artifact":"diff"}', "",
        json.dumps(reported_usage), "full"))
    assert completed["status"] == "completed" and completed["next_action"]["kind"] == "none", completed
    assert completed["current_result"]["counts"] == {"pending": 0, "running": 0, "succeeded": 2, "failed": 0}
    assert completed["current_result"]["progress"] == {"completed": 2, "total": 2, "percent": 100,
                                                          "running_node_id": None}
    assert completed["current_result"]["completed_nodes"][-1]["result"]["artifact"] == "diff"
    assert completed["usage"]["measured_total_tokens"] == 160
    assert completed["usage"]["estimated_tokens"] == 30
    assert completed["usage"]["unknown_model_calls"] == 1
    assert completed["usage"]["protocol_payload_estimate"]["estimated_tokens"] > 0
    assert completed["usage"]["measured_tokens"]["cached_input_tokens"] == 40
    assert completed["usage"]["derived_cost_micros_by_currency"] == {"USD": 12500}
    assert completed["usage"]["providers"] == ["example-provider"]
    assert completed["usage"]["models"] == ["example-model"]
    assert completed["usage"]["reported_attempts"] == 2
    stored_run = json.loads((state_dir / "recipe-runs" / (run_id + ".json")).read_text(encoding="utf-8"))
    assert stored_run["recipeId"] == "recipe_test"
    assert stored_run["recipeRevision"] == 3
    assert stored_run["executableDigest"] == "digest-test"
    assert stored_run["terminalAt"]
    assert all(stored_run["nodes"][node_id]["completedAt"] for node_id in ("understand", "implement"))
    assert stored_run["healthReceipt"]["classification"] == "healthy"
    usage_record = stored_run["usage"]["records"][-1]
    assert usage_record["recipeRunId"] == run_id
    assert usage_record["nodeId"] == "implement" and usage_record["attempt"] == 1
    assert usage_record["measuredTokens"]["input_tokens"] == 120
    assert usage_record["estimatedTokens"] == 30
    assert usage_record["protocolPayloadEstimate"]["estimated_tokens"] > 0
    health_state = json.loads((state_dir / "recipe-health.json").read_text(encoding="utf-8"))
    run_health = next(item for item in health_state["receipts"] if item["runId"] == run_id)
    assert run_health["schema"] == "pkm.recipe.run-health/v1"
    assert run_health["recipe"] == {
        "recipeId": "recipe_test", "revision": 3, "executableDigest": "digest-test"}
    assert run_health["classification"] == "healthy"
    assert run_health["cost"]["attribution"]["attempts"][-1]["nodeId"] == "implement"
    assert run_health["cost"]["attribution"]["attempts"][-1]["attempt"] == 1
    assert run_health["cost"]["measured"]["total-tokens"] == 160
    assert health_state["candidateRequests"] == []
    replayed_usage = response_value(tools["recipe_run_report"](
        run_id, "implement", "succeeded", "report-implement", '{"artifact":"diff"}', "",
        json.dumps(reported_usage), "full"))
    assert replayed_usage["replayed"] is True
    assert replayed_usage["usage"] == completed["usage"]

    usage_summary = response_value(tools["recipe_usage_summary"]("recipe_test"))
    assert usage_summary["ok"] and usage_summary["runs_scanned"] >= 1, usage_summary
    recipe_usage = usage_summary["summaries"][0]
    assert recipe_usage["recipe_id"] == "recipe_test" and recipe_usage["revision"] == 3
    assert recipe_usage["run_count"] == 1
    assert recipe_usage["average_measured_tokens_per_run"] == 160
    assert recipe_usage["average_estimated_tokens_per_run"] == 30
    assert recipe_usage["runs_with_measured_usage"] == 1
    assert recipe_usage["runs_with_unknown_usage"] == 1
    assert recipe_usage["retries"] == 0 and recipe_usage["failures"] == 0
    assert recipe_usage["failed_runs"] == 0

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
    incompatible_gate_definition = json.loads(json.dumps(automated_definition))
    incompatible_gate_definition["spec"]["nodes"][1]["dependsOn"][0]["accept"] = ["succeeded"]
    incompatible_gate = response_value(tools["recipe_run_start_adhoc"](
        "Incompatible approval outcome", json.dumps(incompatible_gate_definition),
        "incompatible-gate-start", '{"logId":"must-not-run"}'))
    assert incompatible_gate["ok"] is False, incompatible_gate
    assert "cannot emit accepted outcome" in incompatible_gate["error"]["message"], incompatible_gate

    string_dependency_definition = json.loads(json.dumps(automated_definition))
    string_dependency_definition["spec"]["nodes"][1]["dependsOn"] = ["permission"]
    string_dependency = response_value(tools["recipe_run_start_adhoc"](
        "Invalid string dependency", json.dumps(string_dependency_definition),
        "string-dependency-start", '{"logId":"must-not-run"}'))
    assert string_dependency["ok"] is False, string_dependency
    assert "dependencies must be objects" in string_dependency["error"]["message"], string_dependency

    rejected = response_value(tools["recipe_run_start_adhoc"](
        "Rejected background module", json.dumps(automated_definition),
        "rejected-start", '{"logId":"must-not-run"}'))
    rejected_id = rejected["run_id"]
    rejected_gate = response_value(tools["recipe_run_next"](rejected_id, "claim-rejected-gate"))
    rejected_result = response_value(tools["recipe_run_submit_input"](
        rejected_id, "permission", rejected_gate["next_action"]["challenge_id"],
        '{"approved":false,"comment":"Do not proceed"}', "reject-gate", "full"))
    assert rejected_result["status"] == "failed", rejected_result
    assert rejected_result["next_action"]["reason"] == "required-node-skipped", rejected_result
    rejected_nodes = {
        item["node_id"]: item for item in rejected_result["current_result"]["completed_nodes"]
    }
    assert rejected_nodes["permission"]["outcome"] == "rejected", rejected_nodes
    assert rejected_nodes["execute"]["outcome"] == "skipped", rejected_nodes
    rejected_run = json.loads(
        (state_dir / "recipe-runs" / f"{rejected_id}.json").read_text(encoding="utf-8"))
    assert rejected_run["healthReceipt"]["classification"] == "recipe-failure"

    automated = response_value(tools["recipe_run_start_adhoc"](
        "Approved background module", json.dumps(automated_definition), "automated-start", '{"logId":"run-42"}'))
    automated_id = automated["run_id"]
    gate = response_value(tools["recipe_run_next"](automated_id, "claim-gate"))
    assert gate["next_action"]["kind"] == "request_user_input", gate
    assert gate["next_action"]["required"] is True
    assert gate["next_action"]["submit_tool"] == "recipe_run_submit_input"
    challenge_id = gate["next_action"]["challenge_id"]
    bypass = response_value(tools["recipe_run_report"](
        automated_id, "permission", "approved", "bypass-gate", '{"approved":true}'))
    assert bypass["ok"] is False and "dedicated runtime adapter" in bypass["error"]["message"], bypass
    invalid_input = response_value(tools["recipe_run_submit_input"](
        automated_id, "permission", challenge_id, '{}', "missing-approval"))
    assert invalid_input["ok"] is False and "explicit boolean" in invalid_input["error"]["message"]
    approved = response_value(tools["recipe_run_submit_input"](
        automated_id, "permission", challenge_id, '{"approved":true,"comment":"Proceed"}', "approve-gate"))
    assert approved["next_action"]["kind"] == "wait_for_background", approved
    assert approved["next_action"]["command"]["args"][-1] == "run-42"
    assert "-c" in approved["next_action"]["command"]["args"]
    final_automated = approved
    for _ in range(100):
        final_automated = response_value(tools["recipe_run_get"](automated_id))
        if final_automated["status"] != "running":
            break
        time.sleep(0.02)
    assert final_automated["status"] == "completed", final_automated
    command_result = final_automated["current_result"]["completed_nodes"][-1]["result"]
    assert command_result["exit_code"] == 0 and command_result["stdout"] == "downloaded:run-42\n", command_result
    assert command_result["stdout_truncated"] is False and command_result["timed_out"] is False
    automated_run = json.loads(
        (state_dir / "recipe-runs" / f"{automated_id}.json").read_text(encoding="utf-8"))
    assert automated_run["healthReceipt"]["classification"] == "healthy"

    autonomous_artifact = pathlib.Path(temporary) / "autonomous-result.txt"
    autonomous_definition = {
        "schema": "pkm.workflow.definition/v1",
        "spec": {"inputs": {}, "nodes": [
            {"nodeId": "prepare", "kind": "pkm.step.command/v1", "config": {
                "program": sys.executable, "args": ["-c",
                    "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('prepared')",
                    str(autonomous_artifact)], "timeoutSeconds": 10, "maxOutputBytes": 4096,
            }, "dependsOn": []},
            {"nodeId": "verify", "kind": "pkm.step.command/v1", "config": {
                "program": sys.executable, "args": ["-c",
                    "import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text() == 'prepared'; print('verified')",
                    str(autonomous_artifact)], "timeoutSeconds": 10, "maxOutputBytes": 4096,
            }, "dependsOn": [{"from": "prepare"}]},
        ], "outputs": {}, "completion": {"requiredNodes": ["verify"]}},
    }
    autonomous = response_value(tools["recipe_run_start_adhoc"](
        "Autonomous command chain", json.dumps(autonomous_definition),
        "autonomous-command-start", autonomous=True))
    assert "poll_with" not in autonomous["next_action"]
    assert autonomous["next_action"]["inspect_with"] == "recipe_run_get"
    autonomous_path = state_dir / "recipe-runs" / f"{autonomous['run_id']}.json"
    for _ in range(300):
        autonomous_run = json.loads(autonomous_path.read_text(encoding="utf-8"))
        if autonomous_run["status"] != "running":
            break
        time.sleep(0.02)
    assert autonomous_run["status"] == "completed", autonomous_run
    assert autonomous_run["nodes"]["verify"]["result"]["stdout"] == "verified\n"
    assert autonomous_run["nodeAttemptCounts"] == {"prepare": 1, "verify": 1}

    def wait_for_autonomous(started, predicate=None):
        run_path = state_dir / "recipe-runs" / f"{started['run_id']}.json"
        for _ in range(500):
            persisted = json.loads(run_path.read_text(encoding="utf-8"))
            if predicate(persisted) if predicate else persisted["status"] != "running":
                return persisted
            time.sleep(0.02)
        raise AssertionError(f"Autonomous run did not reach the expected boundary: {persisted}")

    replayed_autonomous = response_value(tools["recipe_run_start_adhoc"](
        "Autonomous command chain", json.dumps(autonomous_definition),
        "autonomous-command-start", autonomous=True))
    assert replayed_autonomous["replayed"] is True
    changed_autonomous = response_value(tools["recipe_run_start_adhoc"](
        "Autonomous command chain", json.dumps(autonomous_definition),
        "autonomous-command-start", autonomous=True, max_auto_nodes=1))
    assert changed_autonomous["ok"] is False
    assert MODULE._automation_parameters(False, 100, 300) == {}
    for invalid_budget in [0, -1, True, 1001]:
        invalid_automation = response_value(tools["recipe_run_start_adhoc"](
            "Invalid automation budget", json.dumps(autonomous_definition),
            f"invalid-auto-budget-{invalid_budget}", autonomous=True, max_auto_nodes=invalid_budget))
        assert invalid_automation["ok"] is False, invalid_automation

    limited = response_value(tools["recipe_run_start_adhoc"](
        "Node-budget boundary", json.dumps(autonomous_definition),
        "autonomous-node-budget", autonomous=True, max_auto_nodes=1))
    limited_run = wait_for_autonomous(limited)
    assert limited_run["automation"]["status"] == "budget-exceeded", limited_run
    assert limited_run["nodes"]["prepare"]["state"] == "succeeded"
    assert limited_run["nodes"]["verify"]["state"] == "pending"

    failing_definition = json.loads(json.dumps(autonomous_definition))
    failing_definition["spec"]["nodes"][0]["config"]["args"] = ["-c", "raise SystemExit(7)"]
    failing = response_value(tools["recipe_run_start_adhoc"](
        "Failure boundary", json.dumps(failing_definition), "autonomous-failure", autonomous=True))
    failing_run = wait_for_autonomous(failing)
    assert failing_run["status"] == "failed", failing_run
    assert failing_run["nodes"]["prepare"]["result"]["exit_code"] == 7
    assert failing_run["nodes"]["verify"]["state"] == "pending"

    timeout_definition = json.loads(json.dumps(autonomous_definition))
    timeout_definition["spec"]["nodes"][0]["config"]["args"] = ["-c", "import time; time.sleep(30)"]
    timed = response_value(tools["recipe_run_start_adhoc"](
        "Wall-time boundary", json.dumps(timeout_definition), "autonomous-timeout",
        autonomous=True, max_auto_seconds=1))
    timed_run = wait_for_autonomous(timed)
    assert timed_run["automation"]["status"] == "budget-exceeded", timed_run
    assert timed_run["nodes"]["prepare"]["result"]["timed_out"] is True
    assert timed_run["nodes"]["verify"]["state"] == "pending"

    cancellation_marker = pathlib.Path(temporary) / "cancellation-started.txt"
    cancel_definition = json.loads(json.dumps(timeout_definition))
    cancel_definition["spec"]["nodes"][0]["config"]["args"] = ["-c",
        "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('started'); time.sleep(30)",
        str(cancellation_marker)]
    cancellable = response_value(tools["recipe_run_start_adhoc"](
        "Cancellation boundary", json.dumps(cancel_definition), "autonomous-cancel", autonomous=True))
    wait_for_autonomous(cancellable, lambda persisted: cancellation_marker.exists())
    cancellation = response_value(tools["recipe_run_progress"](
        cancellable["run_id"], "prepare", "autonomous-cancel-request",
        '{"cancellationRequested":true}'))
    assert cancellation["ok"] is True, cancellation
    cancelled_run = wait_for_autonomous(cancellable)
    assert cancelled_run["automation"]["status"] == "cancelled", cancelled_run
    assert cancelled_run["nodes"]["prepare"]["result"]["cancelled"] is True
    assert cancelled_run["nodes"]["verify"]["state"] == "pending"

    gate_definition = json.loads(json.dumps(autonomous_definition))
    gate_definition["spec"]["nodes"].insert(1, {
        "nodeId": "approval", "kind": "pkm.gate.human/v1",
        "config": {"prompt": "Approve verification?", "inputKind": "approval"},
        "dependsOn": [{"from": "prepare"}],
    })
    gate_definition["spec"]["nodes"][2]["dependsOn"] = [{"from": "approval", "accept": ["approved"]}]
    gated = response_value(tools["recipe_run_start_adhoc"](
        "Human boundary", json.dumps(gate_definition), "autonomous-human", autonomous=True))
    waiting_gate = wait_for_autonomous(gated, lambda persisted: persisted["automation"]["status"] == "waiting")
    assert waiting_gate["nodes"]["approval"]["state"] == "running"
    assert waiting_gate["nodes"]["verify"]["state"] == "pending"
    gate_resumed = response_value(tools["recipe_run_submit_input"](
        gated["run_id"], "approval", waiting_gate["nodes"]["approval"]["challengeId"],
        '{"approved":true}', "autonomous-human-approve"))
    assert gate_resumed["ok"] is True, gate_resumed
    assert wait_for_autonomous(gated)["status"] == "completed"

    agent_definition = json.loads(json.dumps(gate_definition))
    agent_definition["spec"]["nodes"][1].update({"kind": "pkm.step.noop/v1", "config": {}})
    agent_definition["spec"]["nodes"][2]["dependsOn"] = [{"from": "approval"}]
    agent_boundary = response_value(tools["recipe_run_start_adhoc"](
        "Agent boundary", json.dumps(agent_definition), "autonomous-agent", autonomous=True))
    waiting_agent = wait_for_autonomous(agent_boundary, lambda persisted: persisted["automation"]["status"] == "waiting")
    assert waiting_agent["nodes"]["approval"]["state"] == "pending"
    assert waiting_agent["nodes"]["verify"]["state"] == "pending"
    claimed_agent = response_value(tools["recipe_run_next"](agent_boundary["run_id"], "autonomous-agent-claim"))
    assert claimed_agent["next_action"]["node_id"] == "approval", claimed_agent
    reported_agent = response_value(tools["recipe_run_report"](
        agent_boundary["run_id"], "approval", "succeeded", "autonomous-agent-report", '{}'))
    assert reported_agent["ok"] is True, reported_agent
    assert wait_for_autonomous(agent_boundary)["status"] == "completed"

    original_launcher = MODULE.subprocess.Popen
    def failing_launcher(*arguments, **keywords):
        raise OSError("Injected background launcher failure")
    try:
        MODULE.subprocess.Popen = failing_launcher
        failed_launch = response_value(tools["recipe_run_start_adhoc"](
            "Launcher failure", json.dumps(autonomous_definition), "autonomous-launch-failure", autonomous=True))
    finally:
        MODULE.subprocess.Popen = original_launcher
    assert failed_launch["ok"] is True and failed_launch["status"] == "failed", failed_launch
    assert failed_launch["automation"]["stopReason"] == "command-launch-failed"
    assert wait_for_autonomous(failed_launch)["nodes"]["verify"]["state"] == "pending"
    try:
        MODULE.subprocess.Popen = lambda *arguments, **keywords: type("DeferredLauncher", (), {"pid": 0})()
        recovering = response_value(tools["recipe_run_start_adhoc"](
            "Interrupted completion callback", json.dumps(failing_definition),
            "autonomous-recovery", autonomous=True))
    finally:
        MODULE.subprocess.Popen = original_launcher
    recovery_path = state_dir / "recipe-runs" / f"{recovering['run_id']}.json"
    recovery_state = json.loads(recovery_path.read_text(encoding="utf-8"))
    recovery_result = pathlib.Path(recovery_state["nodes"]["prepare"]["background"]["resultPath"])
    unknown_launch = response_value(tools["recipe_run_next"](recovering["run_id"], "autonomous-unknown-launch"))
    assert unknown_launch["next_action"]["kind"] == "wait_for_background"
    assert unknown_launch["next_action"]["reason"] == "reconciliation-required"
    assert json.loads(recovery_path.read_text())["nodeAttemptCounts"] == {"prepare": 1}
    MODULE._atomic_write(recovery_result, {"ok": True, "exit_code": 0, "stdout": "reconciled"})
    resumed_recovery = response_value(tools["recipe_run_next"](recovering["run_id"], "autonomous-recovery-resume"))
    assert resumed_recovery["ok"] is True, resumed_recovery
    recovered_run = wait_for_autonomous(recovering)
    assert recovered_run["status"] == "completed", recovered_run
    assert recovered_run["nodeAttemptCounts"] == {"prepare": 1, "verify": 1}
    assert recovered_run["nodes"]["prepare"]["result"]["stdout"] == "reconciled"

    script_chain_definition = json.loads(json.dumps(autonomous_definition))
    for node in script_chain_definition["spec"]["nodes"]:
        script = (f"from pathlib import Path; Path({str(autonomous_artifact)!r}).write_text('prepared')"
                  if node["nodeId"] == "prepare" else
                  f"from pathlib import Path; assert Path({str(autonomous_artifact)!r}).read_text() == 'prepared'; print('script-verified')")
        node.update({"kind": "pkm.step.script/v1", "config": {
            "runtime": "python", "environmentId": "runtime-test", "script": script,
            "timeoutSeconds": 10, "maxOutputBytes": 4096,
        }})
    script_chain = response_value(tools["recipe_run_start_adhoc"](
        "Autonomous Script chain", json.dumps(script_chain_definition), "autonomous-scripts", autonomous=True))
    script_chain_run = wait_for_autonomous(script_chain)
    assert script_chain_run["status"] == "completed", script_chain_run
    assert script_chain_run["nodes"]["verify"]["result"]["stdout"] == "script-verified\n"
    assert script_chain_run["nodes"]["prepare"]["result"]["argv"][0] == sys.executable

    concurrency_artifact = pathlib.Path(temporary) / "concurrent-launches.txt"
    concurrency_definition = json.loads(json.dumps(autonomous_definition))
    concurrency_definition["spec"]["nodes"][0]["config"]["args"] = ["-c",
        "import pathlib,sys,time; pathlib.Path(sys.argv[1]).open('a').write('once\\n'); time.sleep(0.2)",
        str(concurrency_artifact)]
    concurrency_definition["spec"]["nodes"][1]["config"]["args"] = ["-c", "print('joined')"]
    concurrent = response_value(tools["recipe_run_start_adhoc"](
        "Concurrent observation", json.dumps(concurrency_definition), "autonomous-concurrent", autonomous=True))
    with ThreadPoolExecutor(max_workers=4) as executor:
        observations = list(executor.map(
            lambda command_id: response_value(tools["recipe_run_next"](concurrent["run_id"], command_id)),
            [f"autonomous-concurrent-next-{index}" for index in range(4)],
        ))
    assert all(observation["ok"] for observation in observations), observations
    concurrent_run = wait_for_autonomous(concurrent)
    assert concurrent_run["status"] == "completed", concurrent_run
    assert concurrent_run["nodeAttemptCounts"] == {"prepare": 1, "verify": 1}
    assert concurrency_artifact.read_text() == "once\n"

    native_count = len(native_calls)
    autonomous_native = response_value(tools["recipe_run_start"](
        native_recipe["recipeId"], "autonomous-native-start", '{"reason":"boundary test"}',
        expected_revision=2, expected_digest=native_digest, autonomous=True))
    assert autonomous_native["automation"]["status"] == "waiting", autonomous_native
    assert len(native_calls) == native_count
    completed_native = response_value(tools["recipe_run_next"](
        autonomous_native["run_id"], "autonomous-native-explicit", ctx=object()))
    assert completed_native["status"] == "completed", completed_native
    assert completed_native["automation"]["status"] == "completed"
    assert len(native_calls) == native_count + 1
    replayed_native = response_value(tools["recipe_run_next"](
        autonomous_native["run_id"], "autonomous-native-explicit", ctx=object()))
    assert replayed_native["replayed"] is True
    assert len(native_calls) == native_count + 1

    for boundary in ("cancelled", "budget-exceeded"):
        waiting_start = response_value(tools["recipe_run_start_adhoc"](
            "Human wait limits", json.dumps(gate_definition),
            "autonomous-human-" + boundary, autonomous=True))
        waiting_state = wait_for_autonomous(
            waiting_start, lambda persisted: persisted["automation"]["status"] == "waiting")
        if boundary == "cancelled":
            cancel_wait = response_value(tools["recipe_run_progress"](
                waiting_start["run_id"], "approval", "autonomous-human-cancel-request",
                '{"cancellationRequested":true}'))
            assert cancel_wait["ok"] is True, cancel_wait
        else:
            waiting_state["automation"]["deadlineAt"] = "2000-01-01T00:00:00+00:00"
            MODULE._atomic_write(state_dir / "recipe-runs" / f"{waiting_start['run_id']}.json", waiting_state)
        after_wait = response_value(tools["recipe_run_submit_input"](
            waiting_start["run_id"], "approval", waiting_state["nodes"]["approval"]["challengeId"],
            '{"approved":true}', "autonomous-human-resume-" + boundary))
        assert after_wait["ok"] is True and after_wait["status"] == "failed", after_wait
        terminal_wait = wait_for_autonomous(waiting_start)
        assert terminal_wait["automation"]["status"] == boundary, terminal_wait
        assert terminal_wait["nodes"]["verify"]["state"] == "pending"

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
        started_script = response_value(tools["recipe_run_start_adhoc"](
            command_prefix, json.dumps(script_definition), command_prefix + "-start", '{}'))
        claimed_script = response_value(tools["recipe_run_next"](
            started_script["run_id"], command_prefix + "-claim"))
        assert claimed_script["next_action"]["kind"] == "wait_for_background", claimed_script
        final_script = claimed_script
        for _ in range(100):
            final_script = response_value(tools["recipe_run_get"](started_script["run_id"]))
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
    missing_health_state = json.loads((state_dir / "recipe-health.json").read_text(encoding="utf-8"))
    missing_health = next(
        item for item in missing_health_state["receipts"]
        if item["runId"] == missing_environment["run_id"])
    assert missing_health["classification"] == "environment-failure"
    assert not missing_health_state["candidateRequests"]

    if os.name != "nt":
        bash_script = run_script("bash", "printf 'bash-script\\n'", "bash-script")
        assert bash_script["status"] == "completed", bash_script
        assert bash_script["current_result"]["completed_nodes"][-1]["result"]["stdout"] == "bash-script\n"
        powershell_script = run_script("powershell", "Write-Output 'must not run'", "powershell-script")
        assert powershell_script["status"] == "failed", powershell_script
        powershell_result = powershell_script["current_result"]["completed_nodes"][-1]["result"]
        assert "supported only on Windows" in powershell_result["error"], powershell_result

    escaped = response_value(tools["recipe_run_start"](
        "recipe_test", "validation-escape-start", '{"request":"validate"}',
        expected_revision=3, expected_digest="digest-test"))
    escaped_id = escaped["run_id"]
    response_value(tools["recipe_run_next"](escaped_id, "validation-escape-claim-understand"))
    escaped_implement = response_value(tools["recipe_run_report"](
        escaped_id, "understand", "succeeded", "validation-escape-report-understand", '{}'))
    assert escaped_implement["next_action"]["node_id"] == "implement"
    escaped_done = response_value(tools["recipe_run_report"](
        escaped_id, "implement", "succeeded", "validation-escape-report-implement",
        '{"validationPassed":false,"secret":"DO-NOT-PERSIST"}'))
    assert escaped_done["status"] == "completed"
    escaped_run = json.loads((state_dir / "recipe-runs" / f"{escaped_id}.json").read_text())
    assert escaped_run["healthReceipt"]["classification"] == "recipe-failure"
    escaped_state = json.loads((state_dir / "recipe-health.json").read_text())
    escaped_receipt = next(item for item in escaped_state["receipts"] if item["runId"] == escaped_id)
    assert escaped_receipt["codes"] == ["validation-escape"]
    assert len(escaped_state["candidateRequests"]) == 1
    assert "DO-NOT-PERSIST" not in json.dumps(escaped_receipt)
    escaped_replay = response_value(tools["recipe_run_report"](
        escaped_id, "implement", "succeeded", "validation-escape-report-implement",
        '{"validationPassed":false,"secret":"DO-NOT-PERSIST"}'))
    assert escaped_replay["replayed"] is True
    assert len(json.loads((state_dir / "recipe-health.json").read_text())["candidateRequests"]) == 1

print("Recipe MCP runtime: autonomous command/Script chains, boundaries, cancellation, budgets, recovery, lazy adapters and replay OK")