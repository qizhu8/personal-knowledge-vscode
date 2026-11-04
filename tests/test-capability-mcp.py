"""Real FastMCP discovery/dispatch, compact exposure, and legacy compatibility."""
import asyncio
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import tempfile

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from capability_api import apply_capability_profile
from knowledge_mutations import register_knowledge_mutation_tools

logging.getLogger("fastmcp").setLevel(logging.CRITICAL)


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-cap-mcp-") as directory:
        server = FastMCP("capability-test")
        register_knowledge_mutation_tools(server, Path(directory), shutil.which("node"), ROOT, {
            "python": sys.executable, "extensionRoot": str(ROOT),
            "database": str(Path(directory) / "private-memory.sqlite3"), "identity": "fixture-local-owner"})
        async with Client(server) as client:
            legacy = await client.list_tools()
            legacy_bytes = len(json.dumps([tool.model_dump(mode="json") for tool in legacy]))
            assert "add_workitem" in {tool.name for tool in legacy}
            async def call(name, **args):
                result = await client.call_tool(name, args)
                return result.structured_content or json.loads(result.content[0].text)
            await call("todo_board_create", title="Board")
            inventory = await call("capabilities_inventory", limit=2)
            assert inventory["total"] == len(legacy)
            assert len(inventory["tools"]) == 2 and inventory["nextOffset"] == 2
            assert inventory["schemaBytes"] > 0
            found = await call("capabilities_search", query="add_workitem")
            assert found["operations"][0]["id"] == "todo.workitem.create"
            assert found["operations"][0]["inputSchema"]["properties"]["item"]
            board = await call("capability_read", operation="todo.board.get", version=1, arguments={"board_slug": "Board"})
            created = await call("capability_call", operation="todo.workitem.create", version=1, arguments={
                "board_slug": "Board", "expected_digest": board["result"]["digest"],
                "item": {"id": "task", "title": "Task", "goal": "Pilot", "scope": "Test", "acceptance": ["Pass"]}})
            assert created["result"]["item"]["id"] == "task"
            memory = await call("capability_call", operation="memory.record.propose", version=1, arguments={
                "content": "Project Todos are managed in PKM.", "operation_id": "mcp-memory-proposal",
                "sources": [{"id": "input-1", "chat": "external-session", "revision": "a" * 32, "locator": "message/input-1"}]})
            assert memory["result"]["status"] == "pending"
            assert (await call("capability_read", operation="memory.record.search", version=1,
                               arguments={"query": "Todos"}))["result"]["records"] == []
            try:
                await call("capability_call", operation="memory.record.confirm", version=1, arguments={
                    "id": memory["result"]["id"], "expected_revision": 1, "operation_id": "fake-confirm"})
            except ToolError as error:
                assert "NOT_AVAILABLE" in str(error)
            else:
                raise AssertionError("MCP spoofed local user confirmation")
            try:
                await call("capability_read", operation="todo.workitem.claim", version=1, arguments={
                    "board_slug": "Board", "id": "task", "expected_digest": created["result"]["digest"]})
            except ToolError as error:
                assert "ACCESS_DENIED" in str(error)
            else:
                raise AssertionError("read entry allowed a mutation")
        original = os.environ.get("PKM_CAPABILITY_PROFILE")
        try:
            os.environ["PKM_CAPABILITY_PROFILE"] = "compact"
            apply_capability_profile(server)
            async with Client(server) as client:
                compact = await client.list_tools()
                assert len(compact) == 6
                assert all(tool.name.startswith(("capabilit",)) for tool in compact)
                compact_bytes = len(json.dumps([tool.model_dump(mode="json") for tool in compact]))
                assert compact_bytes < legacy_bytes * 0.4
                result = await client.call_tool("capability_read", {
                    "operation": "todo.workitem.get", "version": 1, "arguments": {"board_slug": "Board", "id": "task"}})
                assert (result.structured_content or json.loads(result.content[0].text))["result"]["item"]["id"] == "task"
                memory_read = await client.call_tool("capability_read", {
                    "operation": "memory.record.get", "version": 1, "arguments": {"id": memory["result"]["id"]}})
                assert (memory_read.structured_content or json.loads(memory_read.content[0].text))["result"]["status"] == "pending"
                try:
                    await client.call_tool("add_workitem", {})
                except ToolError:
                    pass
                else:
                    raise AssertionError("legacy tool still exposed in compact profile")
                print(json.dumps({"legacy_tools": len(legacy), "compact_tools": len(compact),
                                  "legacy_schema_bytes": legacy_bytes, "compact_schema_bytes": compact_bytes}))
        finally:
            if original is None:
                os.environ.pop("PKM_CAPABILITY_PROFILE", None)
            else:
                os.environ["PKM_CAPABILITY_PROFILE"] = original


asyncio.run(main())
