#!/usr/bin/env python3
"""Agent Sessions are PKM Chat only; the MCP runtime exposes read-only Agent Snapshot access."""
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

RETIRED_TOOLS = {
    "agent_session_start", "agent_session_status", "agent_session_stop", "agent_session_checkpoint",
    "agent_session_load", "agent_session_resume", "agent_session_snapshot_create",
    "agent_session_snapshot_recover", "agent_session_todo_append", "agent_session_todo_replan",
    "agent_session_todo_next", "agent_session_todo_report", "agent_session_export_checkpoint",
    "agent_session_import_checkpoint", "agent_session_end",
}


def response_json(result):
    return json.loads(result.content[0].text)


def write_snapshot(store, snapshot_id, magic_code, session, recipe_runs):
    directory = store / ".pkm" / "state" / "agent-snapshots"
    directory.mkdir(parents=True, exist_ok=True)
    payload = {"session": session, "recipeRuns": recipe_runs}
    snapshot = {
        "schema": MODULE.SNAPSHOT_SCHEMA, "snapshotId": snapshot_id, "magicCode": magic_code,
        "sourceSessionId": session["sessionId"], "sourceHostSessionId": session.get("hostSessionId", ""),
        "sourceHostKind": session.get("hostKind", ""), "task": session["task"], "projectId": "",
        "agent": session.get("agent") or {"name": "Agent", "product": ""}, "reason": "manual",
        "createdAt": "2026-01-01T00:00:00Z", "capture": MODULE._snapshot_capture(payload),
        "payload": MODULE._snapshot_encrypt_payload(payload, snapshot_id, magic_code),
    }
    (directory / (snapshot_id + ".json")).write_text(json.dumps(snapshot), encoding="utf-8")


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-agent-snapshot-read-") as temporary:
        store = pathlib.Path(temporary)
        sessions = store / ".pkm" / "state" / "agent-sessions"
        sessions.mkdir(parents=True)
        long_text = "x" * 6000
        write_snapshot(store, "agent_snapshot_pkm", "PKM-SNAP-AAAA-BBBB-CCCC-DDDD", {
            "schema": "pkm.agent.session/v1", "sessionId": "agent_session_" + "a" * 32,
            "origin": "pkm-native", "runtimeOwner": "pkm", "hostKind": "pkm", "hostSessionId": "chat-1",
            "task": "Ship VIS-02", "status": "paused", "agent": {"name": "PKM API Chat", "product": "PKM"},
            "todos": [{"todoId": "todo_1", "title": "Build", "status": "succeeded", "recipeRunId": "recipe_run_1"},
                      {"todoId": "todo_2", "title": "Validate", "status": "running", "details": long_text}],
            "checkpoints": [{"checkpointId": "cp_1", "sequence": 1, "createdAt": "2026-01-01T00:00:00Z",
                             "reason": "manual", "state": {"summary": "Built, validating", "next_actions": ["run tests"]}}],
            "recipeRunIds": ["recipe_run_1"],
            "nativeChat": {"messages": [{"id": str(index), "role": "user" if index % 2 == 0 else "assistant",
                                          "status": "complete", "content": "message %d" % index} for index in range(20)]},
        }, [{"runId": "recipe_run_1", "recipeId": "recipe_x", "recipeName": "Build", "status": "running",
             "nodes": {"compile": {"state": "succeeded"}, "test": {"state": "running"}}}])
        write_snapshot(store, "agent_snapshot_ext", "PKM-SNAP-1111-2222-3333-4444", {
            "schema": "pkm.agent.session/v1", "sessionId": "agent_session_" + "b" * 24,
            "hostKind": "copilot", "hostSessionId": "copilot-1", "task": "External task", "status": "completed",
            "todos": [{"todoId": "todo_e", "title": "Investigate", "status": "pending"}],
            "checkpoints": [], "recipeRunIds": [],
        }, [])

        mcp = FastMCP("agent-snapshot-read-test")
        registered = MODULE.register_agent_session_tools(mcp, store)
        assert set(registered) == {"agent_session_capabilities", "agent_session_snapshot_list", "agent_session_snapshot_read"}
        async with Client(mcp) as client:
            names = {tool.name for tool in await client.list_tools()}
            assert not names & RETIRED_TOOLS, names & RETIRED_TOOLS
            tools = {tool.name: tool for tool in await client.list_tools()}
            assert tools["agent_session_snapshot_read"].annotations.readOnlyHint is True

            capabilities = response_json(await client.call_tool("agent_session_capabilities", {}))
            assert capabilities["owner"] == "pkm-chat"
            assert capabilities["external_sessions"] == "unsupported"
            assert capabilities["proactive"] is False
            assert capabilities["version"] == "2.0.0"
            assert capabilities["tools"] == ["agent_session_snapshot_list", "agent_session_snapshot_read"]

            listed = response_json(await client.call_tool("agent_session_snapshot_list", {}))
            assert {item["magicCode"] for item in listed["snapshots"]} == {
                "PKM-SNAP-AAAA-BBBB-CCCC-DDDD", "PKM-SNAP-1111-2222-3333-4444"}
            assert all("payload" not in item for item in listed["snapshots"])
            assert {item["sourceHostKind"] for item in listed["snapshots"]} == {"pkm", "copilot"}

            pkm = response_json(await client.call_tool("agent_session_snapshot_read", {
                "magic_code": "pkm-snap-aaaa-bbbb-cccc-dddd"}))
            assert pkm["read_only"] is True and pkm["source"] == "pkm-chat"
            assert pkm["task"] == "Ship VIS-02"
            assert [todo["status"] for todo in pkm["todos"]] == ["succeeded", "running"]
            assert pkm["todos"][0]["recipeRunIds"] == ["recipe_run_1"]
            assert pkm["todos"][1]["details"].endswith("[truncated]") and len(pkm["todos"][1]["details"]) < 2100
            assert pkm["latest_checkpoint_state"]["next_actions"] == ["run tests"]
            assert pkm["recipe_runs"] == [{"runId": "recipe_run_1", "recipeId": "recipe_x", "recipeName": "Build",
                                           "status": "running", "nodes": {"compile": "succeeded", "test": "running"}}]
            assert pkm["conversation"]["message_count"] == 20
            assert [message["content"] for message in pkm["conversation"]["recent_messages"]] == [
                "message %d" % index for index in range(8, 20)]
            short = response_json(await client.call_tool("agent_session_snapshot_read", {
                "magic_code": "PKM-SNAP-AAAA-BBBB-CCCC-DDDD", "recent_messages": 0}))
            assert short["conversation"]["recent_messages"] == []

            external = response_json(await client.call_tool("agent_session_snapshot_read", {
                "magic_code": "PKM-SNAP-1111-2222-3333-4444"}))
            assert external["source"] == "external-agent"
            assert "recipe_runs" not in external and "conversation" not in external
            assert external["todos"] == [{"todoId": "todo_e", "title": "Investigate", "status": "pending"}]

            for arguments, message in (({"magic_code": "PKM-SNAP-0000-0000-0000-0000"}, "not found"),
                                       ({"magic_code": "nope"}, "invalid"),
                                       ({"magic_code": "PKM-SNAP-AAAA-BBBB-CCCC-DDDD", "recent_messages": 51}, "between 0 and 50")):
                try:
                    await client.call_tool("agent_session_snapshot_read", arguments)
                except ToolError as error:
                    assert message in str(error), str(error)
                else:
                    raise AssertionError("snapshot_read accepted " + json.dumps(arguments))

        assert list(sessions.iterdir()) == [], "Reading a Snapshot must never create an Agent Session"
        assert not (store / ".pkm" / "state" / "agent-sessions" / "active").exists()
    print("Agent Snapshot read-only MCP runtime: ok")


asyncio.run(main())
