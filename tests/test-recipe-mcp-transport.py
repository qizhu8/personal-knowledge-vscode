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
        payload = {"state": {"schema": 1, "rootId": "root_transport", "projects": [], "threads": [],
                             "recipes": [recipe], "migrations": [], "audit": []}, "receipts": []}
        envelope = {"schema": 1, "storeVersion": 1, "payload": payload,
                    "digest": hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()}
        (state_dir / "projects.json").write_text(canonical(envelope), encoding="utf-8")

        server = FastMCP("recipe-transport-test")
        MODULE.register_recipe_tools(server, store)
        async with Client(server) as client:
            tool_names = {tool.name for tool in await client.list_tools()}
            assert tool_names == {"recipe_capabilities", "recipe_search", "recipe_run_start",
                                  "recipe_run_get", "recipe_run_next", "recipe_run_report"}

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

    print("Recipe MCP transport: discovery, ordered claims, required bindings, and completion OK")


asyncio.run(main())