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
GUARD_SPEC = importlib.util.spec_from_file_location(
    "mcp_call_guard", ROOT / "resources" / "mcp_call_guard.py")
GUARD_MODULE = importlib.util.module_from_spec(GUARD_SPEC)
GUARD_SPEC.loader.exec_module(GUARD_MODULE)


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

        @mcp.tool()
        def second_recipe_tool():
            return json.dumps({"ok": True, "run_id": "recipe_run_followup"})

        MODULE.register_agent_session_tools(mcp, store)
        mcp.add_middleware(GUARD_MODULE.McpCallGuardMiddleware(mcp))

        async with Client(mcp) as client:
            capabilities = response_json(await client.call_tool("agent_session_capabilities", {}))
            assert capabilities["proactive"] is True
            assert capabilities["version"] == "1.7.6"
            assert capabilities["next_tool"] == "agent_session_start"
            assert "substantial mutating multi-step task" in capabilities["use_when"]
            assert "read-only diagnosis or assessment" in capabilities["do_not_use_when"]
            assert "host chat/session ID" in capabilities["host_session_grouping"]
            assert capabilities["todo_queue"]["policy"].startswith("FIFO")
            assert "call_agent_session_end" in capabilities["todo_queue"]["completion_instruction"]
            assert "agent_session_todo_replan" in capabilities["tools"]
            assert "agent_session_stop" in capabilities["tools"]
            assert "agent_session_snapshot_rotate" not in capabilities["tools"]
            await client.call_tool("ordinary_tool", {})
            session_root = store / ".pkm" / "state" / "agent-sessions"
            assert not list(session_root.glob("*.json")) if session_root.exists() else True

            started = response_json(await client.call_tool("agent_session_start", {
                "task": "Portable managed task", "command_id": "agent-session-test-start",
                "host_session_id": "copilot-session-test",
                "traversal_strategy": "dfs",
            }))
            assert started["host_session_id"] == "copilot-session-test"
            assert started["traversal_strategy"] == "depth-first"
            live_status = response_json(await client.call_tool("agent_session_status", {}))
            assert set(live_status["session"]) == {
                "sessionId", "status", "task", "projectId", "hostSessionId",
                "traversalStrategy", "agent", "currentTodo", "todoCounts",
                "recipeRunIds", "latestCheckpoint", "lastActivity", "liveness",
                "createdAt", "updatedAt",
            }
            assert live_status["session"]["currentTodo"] is None
            assert live_status["session"]["todoCounts"] == {
                "pending": 0, "running": 0, "paused": 0,
                "succeeded": 0, "failed": 0, "skipped": 0,
            }
            assert "todoCommandReceipts" not in live_status["session"]
            full_status = response_json(await client.call_tool(
                "agent_session_status", {"detail": "full"}))
            liveness = full_status["session"]["liveness"]
            assert liveness["owner"]["hostSessionId"] == "copilot-session-test"
            assert len(liveness["owner"]["transportId"]) == 64
            assert liveness["leaseSeconds"] == 300
            assert liveness["heartbeatSequence"] >= 1
            assert liveness["leaseExpiresAt"] > liveness["heartbeatAt"]
            try:
                await client.call_tool("agent_session_start", {
                    "task": "Unrelated child task",
                    "command_id": "agent-session-overwrite-attempt",
                    "host_session_id": "copilot-child-session",
                })
                raise AssertionError("a running Session on the same transport must not be silently replaced")
            except ToolError as error:
                assert "already has a different running Agent Session" in str(error)
            appended = response_json(await client.call_tool("agent_session_todo_append", {
                "todos_json": json.dumps([
                    {"title": "Finish current work", "details": "Do not preempt it."},
                    {"title": "Handle additive request"},
                ]),
                "command_id": "append-initial-todos",
                "detail": "full",
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
            assert "details" not in claimed["todo"]
            assert len(json.dumps(claimed, ensure_ascii=False).encode("utf-8")) < 800
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
                "detail": "full",
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
            assert "summary" not in status_reported["todo"]
            assert len(json.dumps(status_reported, ensure_ascii=False).encode("utf-8")) < 1200
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
            assert "todos" not in cancel_candidate
            cancelled = response_json(await client.call_tool("agent_session_todo_replan", {
                "operation_json": json.dumps({
                    "type": "cancel", "todo_id": cancel_candidate["added_todo_ids"][0],
                    "reason": "Superseded by the latest instruction.",
                }),
                "command_id": "cancel-pending-todo",
                "detail": "full",
            }))
            assert next(todo for todo in cancelled["todos"]
                        if todo["todoId"] == cancel_candidate["added_todo_ids"][0])["status"] == "skipped"
            persisted_session = json.loads(
                (session_root / f"{started['session_id']}.json").read_text(encoding="utf-8"))
            receipt_results = [
                receipt.get("result") or {}
                for receipt in persisted_session["todoCommandReceipts"].values()
            ]
            assert all("todos" not in result for result in receipt_results)
            compact_receipt_todos = [
                result.get(key)
                for result in receipt_results
                for key in ("todo", "resumed_todo")
                if isinstance(result.get(key), dict)
            ]
            assert all("details" not in todo and "summary" not in todo
                       for todo in compact_receipt_todos)
            assert len(json.dumps(
                persisted_session["todoCommandReceipts"],
                ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 262144
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
            followup_run = dict(source_run)
            followup_run["runId"] = "recipe_run_followup"
            followup_run["recipeId"] = "recipe_followup"
            (runs / "recipe_run_followup.json").write_text(json.dumps(followup_run), encoding="utf-8")
            await client.call_tool("second_recipe_tool", {})
            linked = response_json(await client.call_tool(
                "agent_session_status", {"detail": "full"}))
            linked_todo = next(todo for todo in linked["session"]["todos"]
                               if todo["todoId"] == claimed["todo"]["todoId"])
            assert linked_todo["recipeRunId"] == "recipe_run_original"
            assert linked_todo["recipeRunIds"] == ["recipe_run_original", "recipe_run_followup"]
            reported = response_json(await client.call_tool("agent_session_todo_report", {
                "todo_id": claimed["todo"]["todoId"], "status": "succeeded",
                "summary": "Focused validation passed.", "command_id": "report-first-todo",
            }))
            assert reported["todo"]["status"] == "succeeded"
            assert reported["next_action"]["kind"] == "call_agent_session_todo_next"
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
            final_report = response_json(await client.call_tool("agent_session_todo_report", {
                "todo_id": second["todo"]["todoId"], "status": "succeeded",
                "summary": "All queued work passed.", "command_id": "report-final-todo",
            }))
            assert final_report["next_action"]["kind"] == "call_agent_session_end"
            loaded = response_json(await client.call_tool("agent_session_load", {
                "session_id": started["session_id"],
            }))
            assert loaded["latest_checkpoint"]["checkpointId"] == checkpoint["checkpoint_id"]
            assert loaded["session"]["recipeRunIds"] == [
                "recipe_run_original", "recipe_run_followup"]
            assert loaded["session"]["hostSessionId"] == "copilot-session-test"

            exported = response_json(await client.call_tool("agent_session_export_checkpoint", {
                "checkpoint_id": checkpoint["checkpoint_id"],
            }))
            package = store / exported["package_path"]
            assert package.is_dir()
            manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
            assert manifest["sha256"] == exported["sha256"]
            checkpoint_payload = json.loads((package / "checkpoint.json").read_text(encoding="utf-8"))
            assert "liveness" not in checkpoint_payload["session"]

            imported = response_json(await client.call_tool("agent_session_import_checkpoint", {
                "package_name": exported["package_name"],
            }))
            assert imported["session_id"] != started["session_id"]
            assert len(imported["recipe_run_ids"]) == 2
            assert set(imported["recipe_run_ids"]).isdisjoint({
                "recipe_run_original", "recipe_run_followup"})
            imported_run = json.loads(
                (runs / (imported["recipe_run_ids"][0] + ".json")).read_text(encoding="utf-8"))
            assert imported_run["nodes"]["work"]["state"] == "running"
            assert imported_run["agentSessionId"] == imported["session_id"]
            imported_session = json.loads(
                (session_root / (imported["session_id"] + ".json")).read_text(encoding="utf-8"))
            imported_linked_todo = next(
                todo for todo in imported_session["todos"] if todo.get("recipeRunIds"))
            assert imported_linked_todo["recipeRunId"] == imported["recipe_run_ids"][0]
            assert imported_linked_todo["recipeRunIds"] == imported["recipe_run_ids"]

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
            assert "recovery_passphrase" not in snapshot
            assert snapshot["recovery_prompt"] == (
                "Call the PKM MCP function agent_session_snapshot_recover with "
                + json.dumps({
                    "magic_code": snapshot["snapshot"]["magicCode"],
                }, separators=(",", ":"))
                + "."
            )
            assert "fixed local 'uone' obfuscation key" in snapshot["warning"]
            snapshot_files = list(
                (store / ".pkm" / "state" / "agent-snapshots").glob("agent_snapshot_*.json"))
            assert len(snapshot_files) == 1
            snapshot_text = snapshot_files[0].read_text(encoding="utf-8")
            snapshot_record = json.loads(snapshot_text)
            assert "recovery" not in snapshot_record
            assert snapshot_record["payload"]["algorithm"] == "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
            assert "continue validation" not in snapshot_text
            assert snapshot_record["capture"]["todoCount"] > 0

            snapshot_record["capture"] = {"recipeRunCount": 0, "todoCount": 0}
            snapshot_record["payload"] = MODULE._snapshot_encrypt_payload(
                snapshot_record["payload"], snapshot_record["snapshotId"],
                snapshot_record["magicCode"])
            snapshot_files[0].write_text(json.dumps(snapshot_record), encoding="utf-8")

            listed = response_json(await client.call_tool("agent_session_snapshot_list", {}))
            assert listed["snapshots"][0]["magicCode"] == snapshot["snapshot"]["magicCode"]
            assert listed["snapshots"][0]["todoCount"] > 0
            assert listed["snapshots"][0]["recipeRunCount"] == 2
            assert "recovery" not in listed["snapshots"][0]
            repaired_snapshot = json.loads(snapshot_files[0].read_text(encoding="utf-8"))
            repaired_payload = MODULE._snapshot_decrypt_payload(repaired_snapshot)
            assert "session" in repaired_payload
            assert len(repaired_payload["recipeRuns"]) == 2
            assert "algorithm" not in repaired_payload
            snapshot_text = snapshot_files[0].read_text(encoding="utf-8")
            session_files_before_invalid_call = {
                path.name: path.read_text(encoding="utf-8")
                for path in session_root.glob("agent_session_*.json")
            }
            try:
                await client.call_tool("agent_session_snapshot_recover", {
                    "serverName": "pkm",
                    "toolName": "pkm-agent_session_snapshot_recover",
                })
                raise AssertionError("Tool-locator arguments unexpectedly reached Snapshot recovery.")
            except ToolError as error:
                assert '"code":"invalid-tool-arguments"' in str(error)
                assert '"retryable":false' in str(error)
                assert '"missingFields":["magic_code"]' in str(error)
                assert '"unexpectedFields":["serverName","toolName"]' in str(error)
                assert '"exampleArguments":{"magic_code":"<required>"}' in str(error)
            assert snapshot_files[0].read_text(encoding="utf-8") == snapshot_text
            assert {
                path.name: path.read_text(encoding="utf-8")
                for path in session_root.glob("agent_session_*.json")
            } == session_files_before_invalid_call
            try:
                await client.call_tool("agent_session_snapshot_recover", {
                    "magic_code": "pkm-agent_session_snapshot_recover",
                })
                raise AssertionError("Malformed Magic Code unexpectedly reached Snapshot lookup.")
            except ToolError as error:
                assert "Invalid Agent Snapshot Magic Code" in str(error)
                assert "serverName or toolName" in str(error)
            assert snapshot_files[0].read_text(encoding="utf-8") == snapshot_text
            try:
                await client.call_tool("agent_session_snapshot_recover", {
                    "magic_code": "PKM-SNAP-0000-0000-0000-0000",
                })
                raise AssertionError("Missing Snapshot unexpectedly recovered.")
            except ToolError as error:
                assert "current Knowledge Root" in str(error)
                assert "does not contain its locally obfuscated payload" in str(error)
            try:
                await client.call_tool("agent_session_snapshot_recover", {
                    "magic_code": snapshot["snapshot"]["magicCode"],
                    "host_session_id": "copilot-conflicting-session",
                })
                raise AssertionError("Snapshot recovery replaced an active Session on the same transport.")
            except ToolError as error:
                assert "already has a different running Agent Session" in str(error)
            async with Client(mcp) as successor_one:
                first_recovery = response_json(await asyncio.wait_for(
                    successor_one.call_tool("agent_session_snapshot_recover", {
                        "magic_code": snapshot["snapshot"]["magicCode"],
                        "host_session_id": "copilot-successor-one",
                    }),
                    timeout=5,
                ))
            async with Client(mcp) as successor_two:
                second_recovery = response_json(await asyncio.wait_for(
                    successor_two.call_tool("agent_session_snapshot_recover", {
                        "magic_code": snapshot["snapshot"]["magicCode"],
                        "host_session_id": "copilot-successor-two",
                    }),
                    timeout=5,
                ))
            assert first_recovery["session_id"] != second_recovery["session_id"]
            assert first_recovery["snapshot_id"] == second_recovery["snapshot_id"]
            assert first_recovery["next_action"]["kind"] == "call_agent_session_todo_next"
            assert first_recovery["recovery_todo_created"] is True
            first_session = json.loads(
                (session_root / (first_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            second_session = json.loads(
                (session_root / (second_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            assert first_session["hostSessionId"] == "copilot-successor-one"
            assert second_session["hostSessionId"] == "copilot-successor-two"
            assert first_session["provenance"]["kind"] == "agent-snapshot"
            assert [(todo["title"], todo["status"]) for todo in first_session["todos"]] == [
                (todo["title"], todo["status"]) for todo in second_session["todos"]]
            continuation = next(
                todo for todo in first_session["todos"] if todo.get("actionType") == "resume_snapshot")
            assert continuation["status"] == "pending"
            assert "continue validation" in continuation["details"]
            first_linked_todo = next(todo for todo in first_session["todos"] if todo.get("recipeRunId"))
            second_linked_todo = next(todo for todo in second_session["todos"] if todo.get("recipeRunId"))
            assert first_linked_todo["recipeRunId"] != second_linked_todo["recipeRunId"]
            assert len(first_linked_todo["recipeRunIds"]) == 2
            assert len(second_linked_todo["recipeRunIds"]) == 2
            assert set(first_linked_todo["recipeRunIds"]).isdisjoint(
                second_linked_todo["recipeRunIds"])
            first_recovered_run = json.loads(
                (runs / (first_recovery["recipe_run_ids"][0] + ".json")).read_text(encoding="utf-8"))
            assert first_recovered_run["nodes"]["work"] == {"state": "pending"}
            assert snapshot_files[0].read_text(encoding="utf-8") == snapshot_text

            running_magic = "PKM-SNAP-AAAA-1111-BBBB-2222"
            running_snapshot_id = "agent_snapshot_running_claims"
            running_payload = {
                "session": {
                    **first_session,
                    "sessionId": "agent_session_running_source",
                    "todos": [{
                        "todoId": "todo_running", "title": "Resume safely",
                        "status": "running", "startedAt": "2026-09-29T00:00:00Z",
                        "recipeRunId": "recipe_run_running",
                        "recipeRunIds": ["recipe_run_running"],
                    }],
                    "recipeRunIds": ["recipe_run_running"],
                },
                "recipeRuns": [{
                    **source_run,
                    "runId": "recipe_run_running",
                    "nodes": {"work": {
                        "state": "running", "attempt": 1,
                        "startedAt": "2026-09-29T00:00:00Z",
                        "progress": {"phase": "claimed"},
                    }},
                }],
            }
            running_snapshot = {
                "schema": MODULE.SNAPSHOT_SCHEMA,
                "snapshotId": running_snapshot_id,
                "magicCode": running_magic,
                "sourceSessionId": "agent_session_running_source",
                "createdAt": "2026-09-29T00:00:00Z",
                "capture": MODULE._snapshot_capture(running_payload),
                "payload": MODULE._snapshot_encrypt_payload(
                    running_payload, running_snapshot_id, running_magic),
            }
            (snapshot_files[0].parent / (running_snapshot_id + ".json")).write_text(
                json.dumps(running_snapshot), encoding="utf-8")
            async with Client(mcp) as running_successor:
                running_recovery = response_json(await running_successor.call_tool(
                    "agent_session_snapshot_recover", {
                        "magic_code": running_magic,
                        "host_session_id": "copilot-running-successor",
                    }))
            assert running_recovery["recovery_todo_created"] is False
            recovered_running_session = json.loads(
                (session_root / (running_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            assert recovered_running_session["todos"][0]["status"] == "pending"
            assert "startedAt" not in recovered_running_session["todos"][0]
            recovered_running_run = json.loads(
                (runs / (running_recovery["recipe_run_ids"][0] + ".json")).read_text(encoding="utf-8"))
            assert recovered_running_run["nodes"]["work"] == {"state": "pending"}
            sessions_before_failure = set(session_root.glob("agent_session_*.json"))
            runs_before_failure = set(runs.glob("recipe_run_*.json"))
            original_atomic_write = MODULE._atomic_write

            def fail_recovered_session_write(path, value):
                if (path.parent == session_root
                        and (value.get("provenance") or {}).get("kind") == "agent-snapshot"):
                    raise OSError("injected recovered Session write failure")
                original_atomic_write(path, value)

            MODULE._atomic_write = fail_recovered_session_write
            try:
                async with Client(mcp) as failed_successor:
                    try:
                        await asyncio.wait_for(failed_successor.call_tool(
                            "agent_session_snapshot_recover", {
                                "magic_code": snapshot["snapshot"]["magicCode"],
                                "host_session_id": "copilot-successor-failed",
                            }), timeout=5)
                        raise AssertionError("Injected Snapshot recovery failure unexpectedly succeeded.")
                    except ToolError as error:
                        assert "injected recovered Session write failure" in str(error)
            finally:
                MODULE._atomic_write = original_atomic_write
            assert set(session_root.glob("agent_session_*.json")) == sessions_before_failure
            assert set(runs.glob("recipe_run_*.json")) == runs_before_failure

            legacy_snapshot = dict(snapshot_record)
            legacy_snapshot["snapshotId"] = "agent_snapshot_legacy_runtime"
            legacy_snapshot["magicCode"] = "PKM-SNAP-AAAA-BBBB-CCCC-DDDD"
            legacy_snapshot["capture"] = {
                "todoCount": len(loaded["session"]["todos"]),
                "recipeRunCount": 1,
                "latestCheckpointSummary": "Implementation complete.",
            }
            legacy_snapshot["payload"] = {
                "session": loaded["session"],
                "recipeRuns": [source_run],
            }
            legacy_path = snapshot_files[0].parent / "agent_snapshot_legacy_runtime.json"
            legacy_path.write_text(json.dumps(legacy_snapshot), encoding="utf-8")
            await client.call_tool("agent_session_snapshot_list", {})
            migrated_legacy_text = legacy_path.read_text(encoding="utf-8")
            assert "Implementation complete." not in migrated_legacy_text
            assert json.loads(migrated_legacy_text)["payload"]["algorithm"] == "A256GCM-PKM-LOCAL-OBFUSCATION/v1"
            assert "recovery" not in json.loads(migrated_legacy_text)
            async with Client(mcp) as legacy_successor:
                legacy_recovery = response_json(await asyncio.wait_for(
                    legacy_successor.call_tool("agent_session_snapshot_recover", {
                        "magic_code": legacy_snapshot["magicCode"],
                        "host_session_id": "copilot-successor-legacy",
                    }),
                    timeout=5,
                ))
            assert legacy_recovery["snapshot_id"] == legacy_snapshot["snapshotId"]
            stopped = response_json(await client.call_tool("agent_session_stop", {
                "session_id": first_recovery["session_id"],
                "reason": "test-cleanup",
                "summary": "Stopped without claiming completion.",
            }))
            assert stopped["status"] == "stopped"
            stopped_record = json.loads(
                (session_root / (first_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            assert stopped_record["status"] == "stopped"
            assert stopped_record["stopReason"] == "test-cleanup"
            assert stopped_record["stoppedAt"]
            resumed_stopped = response_json(await client.call_tool("agent_session_resume", {
                "session_id": first_recovery["session_id"],
            }))
            assert resumed_stopped["managed"] is True
            resumed_record = json.loads(
                (session_root / (first_recovery["session_id"] + ".json")).read_text(encoding="utf-8"))
            assert resumed_record["status"] == "running"
            assert "stoppedAt" not in resumed_record
            assert "stopReason" not in resumed_record
            stopped_again = response_json(await client.call_tool("agent_session_stop", {
                "session_id": first_recovery["session_id"],
                "reason": "test-finished",
            }))
            assert stopped_again["cleared_active_mappings"] == 1
            status_after_stop = response_json(await client.call_tool("agent_session_status", {}))
            assert status_after_stop["managed"] is False

        async def start_capacity_agent(index):
            async with Client(mcp) as worker:
                started_worker = response_json(await worker.call_tool("agent_session_start", {
                    "task": f"Capacity Agent {index}",
                    "command_id": f"capacity-agent-{index}",
                    "host_session_id": f"capacity-host-{index}",
                }))
                appended_worker = response_json(await worker.call_tool("agent_session_todo_append", {
                    "todos_json": json.dumps([{
                        "title": f"Run bounded task {index}",
                        "details": "Exercise concurrent Agent Session activation.",
                    }]),
                    "command_id": f"capacity-agent-plan-{index}",
                }))
                claimed_worker = response_json(await worker.call_tool("agent_session_todo_next", {
                    "command_id": f"capacity-agent-claim-{index}",
                }))
                assert appended_worker["added_todo_ids"] == [claimed_worker["todo"]["todoId"]]
                return started_worker["session_id"]

        capacity_session_ids = await asyncio.gather(*(start_capacity_agent(index) for index in range(24)))
        assert len(set(capacity_session_ids)) == 24
        active_mappings = list((session_root / "active").glob("*.json"))
        active_capacity_sessions = {
            json.loads(path.read_text(encoding="utf-8")).get("sessionId") for path in active_mappings
        }.intersection(capacity_session_ids)
        assert len(active_capacity_sessions) == 24, active_capacity_sessions

    print("agent session MCP runtime tests passed")


if __name__ == "__main__":
    asyncio.run(main())