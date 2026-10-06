#!/usr/bin/env python3
"""Exercise persistent chat grouping without changing Session/Todo/Recipe identities."""
import asyncio
from concurrent.futures import ProcessPoolExecutor
import importlib.util
import json
import multiprocessing
import subprocess
from pathlib import Path
import tempfile

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("group_runtime", ROOT / "resources/agent_session_runtime.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def concurrent_group(store):
    session = {"sessionId": "agent_session_worker", "hostSessionId": "parallel-chat"}
    MODULE._ensure_session_group(Path(store), session)
    return session["groupId"]


def result(value):
    return json.loads(value.content[0].text)


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-chat-groups-") as temporary:
        store = Path(temporary)
        with ProcessPoolExecutor(max_workers=4, mp_context=multiprocessing.get_context("spawn")) as pool:
            ids = list(pool.map(concurrent_group, [temporary] * 8))
        assert len(set(ids)) == 1
        assert len(list((store / ".pkm/state/agent-groups").glob("*.json"))) == 1
        legacy = {
            "schema": MODULE.SESSION_SCHEMA, "sessionId": "agent_session_legacy",
            "hostSessionId": "chat/shared", "status": "completed", "task": "Old task",
            "createdAt": "2026-01-01", "updatedAt": "2026-01-02",
            "todos": [{"todoId": "old-todo", "recipeRunIds": ["old-run"]}],
            "recipeRunIds": ["old-run"], "checkpoints": [{"summary": "keep"}],
        }
        legacy_path = store / ".pkm/state/agent-sessions/agent_session_legacy.json"
        MODULE._atomic_write(legacy_path, legacy)
        trash_path = store / ".pkm/state/agent-sessions-trash/agent_session_trash.json"
        MODULE._atomic_write(trash_path, {**legacy, "sessionId": "agent_session_trash"})
        mcp = FastMCP("chat-groups")
        MODULE.register_agent_session_tools(mcp, store)
        migrated = json.loads(legacy_path.read_text())
        for chat in ("chat/shared", "中文/chat"):
            vector = {"sessionId": "agent_session_vector", "hostSessionId": chat}
            MODULE._ensure_session_group(store, vector)
            projected = subprocess.run(
                ["node", "-e", "const fs=require('fs');const {agentSessionGroup}=require('./dist/agent-session-lifecycle');process.stdout.write(JSON.stringify(agentSessionGroup(JSON.parse(fs.readFileSync(0,'utf8')))));"],
                input=json.dumps(vector), text=True, capture_output=True, check=True, cwd=ROOT, timeout=10,
            )
            assert json.loads(projected.stdout)["groupId"] == vector["groupId"]
        assert all(migrated[key] == value for key, value in legacy.items())
        assert migrated["taskId"] == legacy["sessionId"]
        assert json.loads(trash_path.read_text())["groupId"] == migrated["groupId"]
        before = legacy_path.read_bytes()
        MODULE._migrate_session_groups(store)
        assert legacy_path.read_bytes() == before
        group_path = store / ".pkm/state/agent-groups" / (migrated["groupId"] + ".json")
        group = json.loads(group_path.read_text())
        group["deletedAt"] = "2026-10-06T18:00:00Z"
        MODULE._atomic_write(group_path, group)
        deleted_group = group_path.read_bytes()
        preserved_trash = trash_path.read_bytes()
        MODULE._migrate_session_groups(store)
        assert group_path.read_bytes() == deleted_group
        assert legacy_path.read_bytes() == before
        assert trash_path.read_bytes() == preserved_trash
        async with Client(mcp) as client:
            async def call(name, **arguments):
                return result(await client.call_tool(name, arguments))

            first = await call("agent_session_start", task="First", command_id="first",
                               host_session_id="chat/shared", agent_name="Agent A")
            assert first["group_id"] == migrated["groupId"]
            assert first["task_id"] == first["session_id"]
            replay = await call("agent_session_start", task="First", command_id="first",
                                host_session_id="chat/shared", agent_name="Agent A")
            assert replay["group_id"] == first["group_id"]
            await call("agent_session_end")
            second = await call("agent_session_start", task="Second", command_id="second",
                                host_session_id="chat/shared", agent_name="Agent B")
            assert second["group_id"] == first["group_id"]
            assert second["task_id"] != first["task_id"]
            await call("agent_session_end")
            different = await call("agent_session_start", task="Different host", command_id="different",
                                   host_session_id="chat/shared", host_kind="claude")
            assert different["group_id"] != first["group_id"]
            await call("agent_session_end")
            unlinked = await call("agent_session_start", task="No chat", command_id="unlinked")
            assert unlinked["group_binding"] == "unlinked" and not unlinked["group_id"]
            bound = await call("agent_session_resume", session_id=unlinked["session_id"],
                               host_session_id="chat/shared")
            assert bound["group_id"] == first["group_id"]
            try:
                await call("agent_session_resume", session_id=unlinked["session_id"],
                           host_session_id="wrong-chat")
                raise AssertionError("A bound Task must not silently move Groups")
            except ToolError as error:
                assert "another chat Group" in str(error)
            await call("agent_session_stop", session_id=unlinked["session_id"])
        restarted = FastMCP("restarted")
        MODULE.register_agent_session_tools(restarted, store)
        assert group_path.read_bytes() == deleted_group
        async with Client(restarted) as client:
            resumed = result(await client.call_tool("agent_session_resume", {"session_id": unlinked["session_id"]}))
            assert resumed["group_id"] == first["group_id"]
        assert json.loads(legacy_path.read_text())["groupId"] == first["group_id"]
        # Corrupt Group metadata is an explicit failure, never a replacement binding.
        group_path = store / ".pkm/state/agent-groups" / (first["group_id"] + ".json")
        MODULE._atomic_write(group_path, {"schema": "wrong"})
        try:
            MODULE._ensure_session_group(store, migrated)
            raise AssertionError("Corrupt binding must fail")
        except ValueError as error:
            assert "conflicts" in str(error)
    print("Agent Group migration, concurrency, identity, restart and binding tests passed")


if __name__ == "__main__":
    asyncio.run(main())
