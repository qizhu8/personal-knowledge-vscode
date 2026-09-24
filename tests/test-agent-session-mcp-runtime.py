#!/usr/bin/env python3
import asyncio
import importlib.util
import json
import pathlib
import tempfile

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "agent_session_runtime", ROOT / "resources" / "agent_session_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def response_json(result):
    return json.loads(result.content[0].text)


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-agent-session-") as temporary:
        store = pathlib.Path(temporary)
        runs = store / ".pkm" / "state" / "recipe-runs"
        runs.mkdir(parents=True)
        mcp = FastMCP("agent-session-test")

        @mcp.tool()
        def ordinary_tool():
            return {"ok": True}

        @mcp.tool()
        def recipe_tool():
            return json.dumps({"ok": True, "run_id": "recipe_run_original"})

        MODULE.register_agent_session_tools(mcp, store)

        async with Client(mcp) as client:
            capabilities = response_json(await client.call_tool("agent_session_capabilities", {}))
            assert capabilities["proactive"] is True
            assert capabilities["next_tool"] == "agent_session_start"
            assert "substantial multi-step task" in capabilities["use_when"]
            assert "host chat/session ID" in capabilities["host_session_grouping"]
            assert capabilities["todo_queue"]["policy"].startswith("FIFO")
            assert "agent_session_todo_replan" in capabilities["tools"]
            await client.call_tool("ordinary_tool", {})
            session_root = store / ".pkm" / "state" / "agent-sessions"
            assert not list(session_root.glob("*.json")) if session_root.exists() else True

            started = response_json(await client.call_tool("agent_session_start", {
                "task": "Portable managed task", "command_id": "agent-session-test-start",
                "host_session_id": "copilot-session-test",
            }))
            assert started["host_session_id"] == "copilot-session-test"
            appended = response_json(await client.call_tool("agent_session_todo_append", {
                "todos_json": json.dumps([
                    {"title": "Finish current work", "details": "Do not preempt it."},
                    {"title": "Handle additive request"},
                ]),
                "command_id": "append-initial-todos",
            }))
            assert [todo["title"] for todo in appended["todos"]] == ["Finish current work", "Handle additive request"]
            repeated = response_json(await client.call_tool("agent_session_todo_append", {
                "todos_json": json.dumps([
                    {"title": "Finish current work", "details": "Do not preempt it."},
                    {"title": "Handle additive request"},
                ]),
                "command_id": "append-initial-todos",
            }))
            assert repeated["added_todo_ids"] == appended["added_todo_ids"]
            claimed = response_json(await client.call_tool("agent_session_todo_next", {
                "command_id": "claim-first-todo",
            }))
            assert claimed["claimed"] is True
            assert claimed["todo"]["title"] == "Finish current work"
            not_preempted = response_json(await client.call_tool("agent_session_todo_next", {
                "command_id": "claim-while-running",
            }))
            assert not_preempted["claimed"] is False
            assert not_preempted["todo"]["todoId"] == claimed["todo"]["todoId"]
            interrupted = response_json(await client.call_tool("agent_session_todo_replan", {
                "session_id": started["session_id"],
                "operation_json": json.dumps({
                    "type": "interrupt", "action_type": "report_status",
                    "target_todo_id": claimed["todo"]["todoId"],
                    "title": "Explain current bug status",
                    "details": "Tell the user what happened before continuing.",
                }),
                "command_id": "interrupt-for-status",
            }))
            assert [todo["status"] for todo in interrupted["todos"][:2]] == ["pending", "paused"]
            status_action = response_json(await client.call_tool("agent_session_todo_next", {
                "command_id": "claim-status-action",
            }))
            assert status_action["todo"]["actionType"] == "report_status"
            status_reported = response_json(await client.call_tool("agent_session_todo_report", {
                "todo_id": status_action["todo"]["todoId"], "status": "succeeded",
                "summary": "Explained root cause and current evidence.", "command_id": "report-status-action",
            }))
            assert status_reported["resumed_todo"]["todoId"] == claimed["todo"]["todoId"]
            resumed = response_json(await client.call_tool("agent_session_todo_next", {
                "command_id": "resume-first-todo",
            }))
            assert resumed["claimed"] is True and resumed["todo"]["todoId"] == claimed["todo"]["todoId"]
            pending_todo_id = appended["added_todo_ids"][1]
            updated = response_json(await client.call_tool("agent_session_todo_replan", {
                "operation_json": json.dumps({
                    "type": "update", "todo_id": pending_todo_id,
                    "title": "Handle revised request", "details": "Use the user's latest instruction.",
                }),
                "command_id": "update-pending-todo",
            }))
            repeated_update = response_json(await client.call_tool("agent_session_todo_replan", {
                "operation_json": json.dumps({
                    "type": "update", "todo_id": pending_todo_id,
                    "title": "Handle revised request", "details": "Use the user's latest instruction.",
                }),
                "command_id": "update-pending-todo",
            }))
            assert repeated_update["affected_todo_ids"] == updated["affected_todo_ids"]
            cancel_candidate = response_json(await client.call_tool("agent_session_todo_append", {
                "todos_json": json.dumps([{"title": "Obsolete pending work"}]),
                "command_id": "append-cancel-candidate",
            }))
            cancelled = response_json(await client.call_tool("agent_session_todo_replan", {
                "operation_json": json.dumps({
                    "type": "cancel", "todo_id": cancel_candidate["added_todo_ids"][0],
                    "reason": "Superseded by the latest instruction.",
                }),
                "command_id": "cancel-pending-todo",
            }))
            assert next(todo for todo in cancelled["todos"]
                        if todo["todoId"] == cancel_candidate["added_todo_ids"][0])["status"] == "skipped"
            source_run = {
                "schema": "pkm.recipe.run/v1", "runId": "recipe_run_original",
                "status": "running", "version": 2, "recipeId": "recipe_test",
                "recipeRevision": 1, "executableDigest": "d" * 64, "projectId": "",
                "definition": {"schema": "pkm.workflow.definition/v1", "spec": {
                    "nodes": [{"nodeId": "work", "kind": "pkm.step.noop/v1", "dependsOn": []}],
                    "completion": {"requiredNodes": ["work"]},
                }},
                "nodes": {"work": {"state": "running"}}, "loops": {},
                "ancestry": ["recipe_test"], "inputs": {}, "receipts": {},
                "createdAt": "2026-09-22T00:00:00Z", "updatedAt": "2026-09-22T00:00:00Z",
            }
            (runs / "recipe_run_original.json").write_text(json.dumps(source_run), encoding="utf-8")
            await client.call_tool("recipe_tool", {})
            linked = response_json(await client.call_tool("agent_session_status", {}))
            linked_todo = next(todo for todo in linked["session"]["todos"]
                               if todo["todoId"] == claimed["todo"]["todoId"])
            assert linked_todo["recipeRunId"] == "recipe_run_original"
            reported = response_json(await client.call_tool("agent_session_todo_report", {
                "todo_id": claimed["todo"]["todoId"], "status": "succeeded",
                "summary": "Focused validation passed.", "command_id": "report-first-todo",
            }))
            assert reported["todo"]["status"] == "succeeded"
            second = response_json(await client.call_tool("agent_session_todo_next", {
                "command_id": "claim-second-todo",
            }))
            assert second["todo"]["title"] == "Handle revised request"

            checkpoint = response_json(await client.call_tool("agent_session_checkpoint", {
                "state_json": json.dumps({
                    "summary": "Implementation complete.",
                    "completed": ["implementation"],
                    "in_progress": ["validation"],
                    "decisions": ["Use immutable checkpoint Packages."],
                    "files": ["resources/agent_session_runtime.py"],
                    "validation": ["transport test passed"],
                    "next_actions": ["resume validation"],
                }),
                "reason": "handoff",
            }))
            loaded = response_json(await client.call_tool("agent_session_load", {
                "session_id": started["session_id"],
            }))
            assert loaded["latest_checkpoint"]["checkpointId"] == checkpoint["checkpoint_id"]
            assert loaded["session"]["recipeRunIds"] == ["recipe_run_original"]
            assert loaded["session"]["hostSessionId"] == "copilot-session-test"

            exported = response_json(await client.call_tool("agent_session_export_checkpoint", {
                "checkpoint_id": checkpoint["checkpoint_id"],
            }))
            package = store / exported["package_path"]
            assert package.is_dir()
            manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
            assert manifest["sha256"] == exported["sha256"]

            imported = response_json(await client.call_tool("agent_session_import_checkpoint", {
                "package_name": exported["package_name"],
            }))
            assert imported["session_id"] != started["session_id"]
            assert imported["recipe_run_ids"] != ["recipe_run_original"]
            imported_run = json.loads(
                (runs / (imported["recipe_run_ids"][0] + ".json")).read_text(encoding="utf-8"))
            assert imported_run["nodes"]["work"]["state"] == "running"
            assert imported_run["agentSessionId"] == imported["session_id"]

            resumed = response_json(await client.call_tool("agent_session_resume", {
                "session_id": imported["session_id"],
            }))
            assert resumed["managed"] is True
            assert resumed["latest_checkpoint"]["state"]["next_actions"] == ["resume validation"]

            snapshot = response_json(await client.call_tool("agent_session_snapshot_create", {
                "reason": "restart",
                "state_json": json.dumps({
                    "summary": "Ready to restart in a lighter conversation.",
                    "next_actions": ["continue validation"],
                }),
            }))
            assert snapshot["snapshot"]["magicCode"].startswith("PKM-SNAP-")
            assert snapshot["recovery_passphrase"] in snapshot["recovery_prompt"]
            snapshot_files = list(
                (store / ".pkm" / "state" / "agent-snapshots").glob("agent_snapshot_*.json"))
            assert len(snapshot_files) == 1
            snapshot_text = snapshot_files[0].read_text(encoding="utf-8")
            assert snapshot["recovery_passphrase"] not in snapshot_text
            snapshot_record = json.loads(snapshot_text)
            assert snapshot_record["recovery"]["algorithm"] == "scrypt-sha256/v1"
            assert snapshot_record["payload"]["session"]["todos"]

            listed = response_json(await client.call_tool("agent_session_snapshot_list", {}))
            assert listed["snapshots"][0]["magicCode"] == snapshot["snapshot"]["magicCode"]
            assert "recovery" not in listed["snapshots"][0]
            try:
                await client.call_tool("agent_session_snapshot_recover", {
                    "magic_code": snapshot["snapshot"]["magicCode"],
                    "recovery_passphrase": "WRONG-PASSPHRASE",
                })
                raise AssertionError("Incorrect Snapshot recovery passphrase was accepted.")
            except ToolError as error:
                assert "incorrect" in str(error)
            first_recovery = response_json(await client.call_tool("agent_session_snapshot_recover", {
                "magic_code": snapshot["snapshot"]["magicCode"],
                "recovery_passphrase": snapshot["recovery_passphrase"],
                "host_session_id": "copilot-successor-one",
            }))
            second_recovery = response_json(await client.call_tool("agent_session_snapshot_recover", {
                "magic_code": snapshot["snapshot"]["magicCode"],
                "recovery_passphrase": snapshot["recovery_passphrase"],
                "host_session_id": "copilot-successor-two",
            }))
            assert first_recovery["session_id"] != second_recovery["session_id"]
            assert first_recovery["snapshot_id"] == second_recovery["snapshot_id"]
            first_session = json.loads(
                (session_root / (first_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            second_session = json.loads(
                (session_root / (second_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            assert first_session["hostSessionId"] == "copilot-successor-one"
            assert second_session["hostSessionId"] == "copilot-successor-two"
            assert first_session["provenance"]["kind"] == "agent-snapshot"
            assert [(todo["title"], todo["status"]) for todo in first_session["todos"]] == [
                (todo["title"], todo["status"]) for todo in second_session["todos"]]
            first_linked_todo = next(todo for todo in first_session["todos"] if todo.get("recipeRunId"))
            second_linked_todo = next(todo for todo in second_session["todos"] if todo.get("recipeRunId"))
            assert first_linked_todo["recipeRunId"] != second_linked_todo["recipeRunId"]
            assert snapshot_files[0].read_text(encoding="utf-8") == snapshot_text

    print("agent session MCP runtime tests passed")


if __name__ == "__main__":
    asyncio.run(main())