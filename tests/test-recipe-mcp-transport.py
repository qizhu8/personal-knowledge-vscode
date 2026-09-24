#!/usr/bin/env python3
import asyncio
import hashlib
import importlib.util
import json
import pathlib
import tempfile

from fastmcp import Client, FastMCP


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources" / "recipe_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def response_json(result):
    return json.loads(result.content[0].text)


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-recipe-transport-") as temporary:
        store = pathlib.Path(temporary)
        state_dir = store / ".pkm" / "state"
        state_dir.mkdir(parents=True)
        binding_hash = hashlib.sha256(b"Validate the implementation.").hexdigest()
        recipe = {
            "recipeId": "recipe_transport", "scope": "global", "category": "Software Development",
            "name": "Transport Test", "description": "Exercise a Recipe through MCP.",
            "revision": 2, "executableDigest": "transport-digest",
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {},
                "nodes": [
                    {"nodeId": "understand", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []},
                    {"nodeId": "implement", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                        {"from": "understand", "accept": ["succeeded"], "required": True}
                    ]},
                ],
                "outputs": {}, "completion": {"requiredNodes": ["implement"]},
            }},
            "nodeBindings": [{"nodeId": "implement", "bindings": [{
                "bindingId": "validate", "kind": "skill", "knowledgeId": "Coding/Validate",
                "contentHash": binding_hash, "usage": "required",
            }]}],
        }
        branch_recipe = {
            "recipeId": "recipe_branch_example", "scope": "global", "category": "Examples",
            "name": "Approval Branch Example", "description": "Execute only the selected approval path.",
            "revision": 1, "executableDigest": "branch-example-digest",
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {},
                "nodes": [
                    {"nodeId": "classify", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [],
                     "control": {"mode": "branch", "kind": "if", "cases": ["approved", "rejected"]}},
                    {"nodeId": "approve", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                        {"from": "classify", "accept": ["approved"], "required": True}
                    ]},
                    {"nodeId": "reject", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                        {"from": "classify", "accept": ["rejected"], "required": True}
                    ]},
                    {"nodeId": "deliver", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                        {"from": "approve", "accept": ["succeeded", "skipped"], "required": True},
                        {"from": "reject", "accept": ["succeeded", "skipped"], "required": True},
                    ]},
                ],
                "outputs": {}, "completion": {"requiredNodes": ["deliver"]},
            }},
        }
        loop_nodes = [
            {"nodeId": "work", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                {"from": "check", "accept": ["repeat"], "required": True,
                 "loop": {"termination": {"condition": "quality >= target", "maxIterations": 2}}}
            ]},
            {"nodeId": "check", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                {"from": "work", "accept": ["succeeded"], "required": True}
            ], "control": {"mode": "branch", "kind": "if", "cases": ["repeat", "done"]}},
            {"nodeId": "deliver", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                {"from": "check", "accept": ["done"], "required": True}
            ]},
        ]
        loop_recipe = {
            "recipeId": "recipe_loop_example", "scope": "global", "category": "Examples",
            "name": "Bounded Quality Loop Example", "description": "Repeat work until the check exits.",
            "revision": 1, "executableDigest": "loop-example-digest",
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {}, "nodes": loop_nodes, "outputs": {},
                "completion": {"requiredNodes": ["deliver"]},
            }},
        }
        limit_recipe = {**loop_recipe, "recipeId": "recipe_loop_limit_example",
                        "name": "Bounded Quality Loop Limit Example",
                        "executableDigest": "loop-limit-example-digest"}
        child_digest = "c" * 64
        child_recipe = {
            "recipeId": "recipe_child_example", "scope": "global", "category": "Examples",
            "name": "Child Validation Example", "description": "Perform child validation.",
            "revision": 4, "executableDigest": child_digest,
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {}, "nodes": [
                    {"nodeId": "child_validate", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []}
                ], "outputs": {}, "completion": {"requiredNodes": ["child_validate"]},
            }},
        }
        parent_recipe = {
            "recipeId": "recipe_parent_example", "scope": "global", "category": "Examples",
            "name": "Parent Delivery Example", "description": "Run a pinned child before delivery.",
            "revision": 2, "executableDigest": "p" * 64,
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {}, "nodes": [
                    {"nodeId": "prepare", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []},
                    {"nodeId": "validate_child", "kind": "pkm.subflow/v1",
                     "config": {"recipeId": "recipe_child_example", "revision": 4,
                                "executableDigest": child_digest},
                     "dependsOn": [{"from": "prepare", "accept": ["succeeded"], "required": True}]},
                    {"nodeId": "deliver", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [
                        {"from": "validate_child", "accept": ["succeeded"], "required": True}
                    ]},
                ], "outputs": {}, "completion": {"requiredNodes": ["deliver"]},
            }},
        }
        recursive_digest = "d" * 64
        recursive_recipe = {
            "recipeId": "recipe_recursive_example", "scope": "global", "category": "Examples",
            "name": "Recursive Rejection Example", "description": "Must be rejected.",
            "revision": 1, "executableDigest": recursive_digest,
            "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                "inputs": {}, "nodes": [
                    {"nodeId": "recurse", "kind": "pkm.subflow/v1",
                     "config": {"recipeId": "recipe_recursive_example", "revision": 1,
                                "executableDigest": recursive_digest}, "dependsOn": []}
                ], "outputs": {}, "completion": {"requiredNodes": ["recurse"]},
            }},
        }
        payload = {"state": {"schema": 1, "rootId": "root_transport", "projects": [], "threads": [],
                             "recipes": [recipe, branch_recipe, loop_recipe, limit_recipe,
                                         child_recipe, parent_recipe, recursive_recipe],
                             "migrations": [], "audit": []}, "receipts": []}
        envelope = {"schema": 1, "storeVersion": 1, "payload": payload,
                    "digest": hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()}
        (state_dir / "projects.json").write_text(canonical(envelope), encoding="utf-8")

        server = FastMCP("recipe-transport-test")
        MODULE.register_recipe_tools(server, store)
        async with Client(server) as client:
            tool_names = {tool.name for tool in await client.list_tools()}
            assert tool_names == {"recipe_capabilities", "recipe_search", "recipe_create_from_skill", "recipe_run_start",
                                  "recipe_run_start_adhoc", "recipe_run_get", "recipe_run_next",
                                  "recipe_run_report", "recipe_run_submit_input"}

            started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_transport", "command_id": "transport-start",
                "inputs_json": '{"request":"prove transport"}', "expected_revision": 2,
                "expected_digest": "transport-digest",
            }))
            assert started["next_action"]["kind"] == "call_recipe_run_next"
            run_id = started["run_id"]

            first = response_json(await client.call_tool("recipe_run_next", {
                "run_id": run_id, "command_id": "transport-next-understand",
            }))
            assert first["next_action"]["node_id"] == "understand"
            still_running = response_json(await client.call_tool("recipe_run_get", {"run_id": run_id}))
            assert still_running["next_action"] == {
                "kind": "report_node", "run_id": run_id, "node_id": "understand",
                "accepted_outcomes": ["succeeded", "failed"],
            }

            second = response_json(await client.call_tool("recipe_run_report", {
                "run_id": run_id, "node_id": "understand", "outcome": "succeeded",
                "command_id": "transport-report-understand", "result_json": '{"summary":"understood"}',
            }))
            assert second["next_action"]["node_id"] == "implement"
            assert second["next_action"]["knowledge_bindings"][0]["usage"] == "required"
            assert second["next_action"]["knowledge_bindings"][0]["contentHash"] == binding_hash

            completed = response_json(await client.call_tool("recipe_run_report", {
                "run_id": run_id, "node_id": "implement", "outcome": "succeeded",
                "command_id": "transport-report-implement", "result_json": '{"artifact":"verified-diff"}',
            }))
            assert completed["status"] == "completed"
            assert completed["current_result"]["counts"] == {
                "pending": 0, "running": 0, "succeeded": 2, "failed": 0,
            }

            branch_started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_branch_example", "command_id": "branch-start",
                "inputs_json": '{"approval":true}', "expected_revision": 1,
                "expected_digest": "branch-example-digest",
            }))
            branch_id = branch_started["run_id"]
            classifier = response_json(await client.call_tool("recipe_run_next", {
                "run_id": branch_id, "command_id": "branch-next-classifier",
            }))
            assert classifier["next_action"]["node_id"] == "classify"
            assert classifier["next_action"]["accepted_outcomes"] == ["approved", "rejected", "failed"]

            selected = response_json(await client.call_tool("recipe_run_report", {
                "run_id": branch_id, "node_id": "classify", "outcome": "approved",
                "command_id": "branch-report-classifier", "result_json": '{"reason":"policy passed"}',
            }))
            assert selected["next_action"]["node_id"] == "approve"
            assert selected["current_result"]["counts"]["skipped"] == 1

            joined = response_json(await client.call_tool("recipe_run_report", {
                "run_id": branch_id, "node_id": "approve", "outcome": "succeeded",
                "command_id": "branch-report-approve", "result_json": '{"decision":"approved"}',
            }))
            assert joined["next_action"]["node_id"] == "deliver"
            branch_completed = response_json(await client.call_tool("recipe_run_report", {
                "run_id": branch_id, "node_id": "deliver", "outcome": "succeeded",
                "command_id": "branch-report-deliver", "result_json": '{"delivered":true}',
            }))
            assert branch_completed["status"] == "completed"
            assert branch_completed["current_result"]["counts"] == {
                "pending": 0, "running": 0, "succeeded": 3, "failed": 0, "skipped": 1,
            }
            outcomes = {item["node_id"]: item["outcome"]
                        for item in branch_completed["current_result"]["completed_nodes"]}
            assert outcomes == {"classify": "approved", "approve": "succeeded",
                                "reject": "skipped", "deliver": "succeeded"}

            loop_started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_loop_example", "command_id": "loop-start",
                "expected_revision": 1, "expected_digest": "loop-example-digest",
            }))
            loop_id = loop_started["run_id"]
            work_one = response_json(await client.call_tool("recipe_run_next", {
                "run_id": loop_id, "command_id": "loop-next-work-1",
            }))
            assert work_one["next_action"]["node_id"] == "work"
            assert work_one["next_action"]["loop_context"][0]["iteration"] == 1
            check_one = response_json(await client.call_tool("recipe_run_report", {
                "run_id": loop_id, "node_id": "work", "outcome": "succeeded",
                "command_id": "loop-report-work-1", "result_json": '{"quality":0.4}',
            }))
            assert check_one["next_action"]["node_id"] == "check"
            work_two = response_json(await client.call_tool("recipe_run_report", {
                "run_id": loop_id, "node_id": "check", "outcome": "repeat",
                "command_id": "loop-report-check-1", "result_json": '{"quality":0.4}',
            }))
            assert work_two["next_action"]["node_id"] == "work"
            assert work_two["next_action"]["loop_context"][0]["iteration"] == 2
            check_two = response_json(await client.call_tool("recipe_run_report", {
                "run_id": loop_id, "node_id": "work", "outcome": "succeeded",
                "command_id": "loop-report-work-2", "result_json": '{"quality":0.9}',
            }))
            assert check_two["next_action"]["node_id"] == "check"
            deliver = response_json(await client.call_tool("recipe_run_report", {
                "run_id": loop_id, "node_id": "check", "outcome": "done",
                "command_id": "loop-report-check-2", "result_json": '{"quality":0.9}',
            }))
            assert deliver["next_action"]["node_id"] == "deliver"
            loop_completed = response_json(await client.call_tool("recipe_run_report", {
                "run_id": loop_id, "node_id": "deliver", "outcome": "succeeded",
                "command_id": "loop-report-deliver", "result_json": '{"artifact":"accepted"}',
            }))
            assert loop_completed["status"] == "completed"
            loop_state = loop_completed["current_result"]["control_state"]["loops"][0]
            assert loop_state["state"] == "completed"
            assert loop_state["iteration"] == 2 and len(loop_state["history"]) == 2
            assert loop_state["history"][0]["nodes"]["check"]["outcome"] == "repeat"
            assert loop_state["history"][1]["nodes"]["check"]["outcome"] == "done"

            limit_started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_loop_limit_example", "command_id": "loop-limit-start",
                "expected_revision": 1, "expected_digest": "loop-limit-example-digest",
            }))
            limit_id = limit_started["run_id"]
            for iteration in [1, 2]:
                work = response_json(await client.call_tool("recipe_run_next", {
                    "run_id": limit_id, "command_id": f"loop-limit-next-work-{iteration}",
                })) if iteration == 1 else repeated
                assert work["next_action"]["node_id"] == "work"
                check = response_json(await client.call_tool("recipe_run_report", {
                    "run_id": limit_id, "node_id": "work", "outcome": "succeeded",
                    "command_id": f"loop-limit-report-work-{iteration}",
                }))
                repeated = response_json(await client.call_tool("recipe_run_report", {
                    "run_id": limit_id, "node_id": "check", "outcome": "repeat",
                    "command_id": f"loop-limit-report-check-{iteration}",
                }))
            assert repeated["status"] == "failed"
            assert repeated["next_action"]["reason"] == "loop-limit-reached"
            limited = repeated["current_result"]["control_state"]["loops"][0]
            assert limited["state"] == "limited" and len(limited["history"]) == 2

            parent_started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_parent_example", "command_id": "parent-start",
                "inputs_json": '{"artifact":"candidate"}', "expected_revision": 2,
                "expected_digest": "p" * 64,
            }))
            parent_id = parent_started["run_id"]
            prepare = response_json(await client.call_tool("recipe_run_next", {
                "run_id": parent_id, "command_id": "parent-next-prepare",
            }))
            assert prepare["next_action"]["node_id"] == "prepare"
            nested = response_json(await client.call_tool("recipe_run_report", {
                "run_id": parent_id, "node_id": "prepare", "outcome": "succeeded",
                "command_id": "parent-report-prepare", "result_json": '{"prepared":true}',
            }))
            assert nested["next_action"]["kind"] == "run_subrecipe"
            assert nested["next_action"]["pinned_recipe"] == {
                "recipe_id": "recipe_child_example", "revision": 4,
                "executable_digest": child_digest,
            }
            child_id = nested["next_action"]["child_run_id"]
            rejected_manual = response_json(await client.call_tool("recipe_run_report", {
                "run_id": parent_id, "node_id": "validate_child", "outcome": "succeeded",
                "command_id": "parent-fake-child-report",
            }))
            assert rejected_manual["ok"] is False
            assert "cannot be reported manually" in rejected_manual["error"]["message"]

            child_claimed = response_json(await client.call_tool("recipe_run_next", {
                "run_id": child_id, "command_id": "child-next-validate",
            }))
            assert child_claimed["next_action"]["node_id"] == "child_validate"
            child_completed = response_json(await client.call_tool("recipe_run_report", {
                "run_id": child_id, "node_id": "child_validate", "outcome": "succeeded",
                "command_id": "child-report-validate", "result_json": '{"valid":true}',
            }))
            assert child_completed["status"] == "completed"

            parent_resumed = response_json(await client.call_tool("recipe_run_next", {
                "run_id": parent_id, "command_id": "parent-next-after-child",
            }))
            assert parent_resumed["next_action"]["node_id"] == "deliver"
            mapped = {item["node_id"]: item for item in parent_resumed["current_result"]["completed_nodes"]}
            assert mapped["validate_child"]["result"]["child_run_id"] == child_id
            assert mapped["validate_child"]["result"]["child_result"]["counts"]["succeeded"] == 1
            parent_completed = response_json(await client.call_tool("recipe_run_report", {
                "run_id": parent_id, "node_id": "deliver", "outcome": "succeeded",
                "command_id": "parent-report-deliver", "result_json": '{"delivered":true}',
            }))
            assert parent_completed["status"] == "completed"
            assert parent_completed["current_result"]["counts"]["succeeded"] == 3

            recursive_started = response_json(await client.call_tool("recipe_run_start", {
                "recipe_id": "recipe_recursive_example", "command_id": "recursive-start",
                "expected_revision": 1, "expected_digest": recursive_digest,
            }))
            recursive_claim = response_json(await client.call_tool("recipe_run_next", {
                "run_id": recursive_started["run_id"], "command_id": "recursive-next",
            }))
            assert recursive_claim["ok"] is False
            assert "Recursive Recipe subflow" in recursive_claim["error"]["message"]

    print("Recipe MCP transport: linear, branch, bounded loops, pinned sub-Recipe, and recursion guard OK")


asyncio.run(main())