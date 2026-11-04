"""Exercise the actual FastMCP registry, Python bridge and persisted TypeScript Board."""
import asyncio
import json
import logging
import pathlib
import shutil
import subprocess
import sys
import tempfile

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError
logging.getLogger("fastmcp").setLevel(logging.CRITICAL)

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from knowledge_mutations import register_knowledge_mutation_tools


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-todo-mcp-") as directory:
        root = pathlib.Path(directory)
        node = shutil.which("node")
        server = FastMCP("todo-api-integration")
        register_knowledge_mutation_tools(server, root, node, ROOT)
        definitions = json.loads(subprocess.check_output([
            node, "-e", "console.log(JSON.stringify(require('./dist/knowledge/todo-api-contract').todoApiDefinitions))"
        ], cwd=ROOT, text=True))

        async with Client(server) as client:
            tools = {tool.name: tool for tool in await client.list_tools()}
            for definition in definitions:
                tool = tools[definition["name"]]
                assert tool.annotations.readOnlyHint == definition["readOnly"]
                expected = set(definition["parameters"]["properties"])
                actual = set(tool.inputSchema["properties"])
                assert actual - {"worker_token"} == expected, (tool.name, actual, expected)
                assert set(tool.inputSchema.get("required", [])) == set(definition["parameters"]["required"])
            seen = set()

            async def call(name, **args):
                result = await client.call_tool(name, args)
                seen.add(name)
                return result.structured_content or json.loads(result.content[0].text)

            async def rejected(name, expected_error=None, **args):
                try:
                    await call(name, **args)
                except ToolError as error:
                    if expected_error:
                        assert expected_error in str(error), str(error)
                    return
                raise AssertionError(f"{name} unexpectedly succeeded")

            await call("todo_board_create", title="Board")
            board = {"board_slug": "Board"}
            current = await call("get_board", **board)

            async def write(name, **args):
                nonlocal current
                current = await call(name, **board, expected_digest=current["digest"], **args)
                return current

            def item(id, **extra):
                return {"id": id, "title": id, "goal": "User value", "scope": "MCP",
                        "acceptance": ["Verified"], **extra}

            await write("add_userstory", item=item("story"))
            await write("add_workitem", item=item("task", parentId="story"))
            await call("list_boards")
            await call("list_agents", **board)
            await call("list_userstories", **board)
            await call("get_userstory", **board, id="story")
            await call("list_workitems", **board, states=["todo"], actionable=True)
            task = await call("get_workitem", **board, id="task")
            assert task["item"].get("ownerId") is None
            await write("update_workitem", id="task", patch={"title": "Updated by MCP"}, reason="Clarify")
            await write("update_userstory", id="story", patch={"goal": "Updated Story value"}, reason="Clarify")
            await write("move_workitem", id="task", reason="Remove parent")
            await write("move_workitem", id="task", story_id="story", reason="Restore parent")
            await write("assign_workitem", id="task", owner_id="mcp:external", reason="Explicit assignment")
            stale = current["digest"]
            await write("claim_workitem", id="task")
            assert current["item"]["ownerId"] == "mcp:external"
            await rejected("claim_workitem", **board, id="task", expected_digest=stale)
            await write("change_workitem_state", id="task", state="blocked", blocked_reason="Service down")
            await write("release_workitem", id="task", reason="Handoff")
            await write("claim_workitem", id="task")
            await write("submit_workitem_result", id="task", outcome="Success", evidence=["test://mcp"],
                        verification=[{"layer": "unit", "status": "passed", "evidence": ["test://unit"]}])
            assert current["item"]["status"] == "completed"
            assert not current["item"].get("acceptanceDecision")
            await rejected("accept_workitem", **board, id="task", expected_digest=current["digest"], reason="Self approve")
            await write("reopen_workitem", id="task", reason="Follow-up")
            await write("add_workitem_comment", id="task", text="进度：已验证")
            assert current["item"]["comments"][-1]["text"] == "进度：已验证"
            await call("list_workitem_history", **board, id="task", limit=2)
            await write("delete_workitem", id="task", reason="Archive")
            assert (await call("list_workitems", **board))["total"] == 0
            assert (await call("list_workitems", **board, include_deleted=True))["total"] == 1
            await write("delete_userstory", id="story", reason="Archive parent")
            await write("restore_userstory", id="story", reason="Restore parent")
            await write("restore_workitem", id="task", reason="Restore task")
            await write("change_userstory_state", id="story", state="active")
            await rejected("change_userstory_state", **board, id="story", expected_digest=current["digest"],
                           state="completed", outcome="Success", evidence=["test://story"])
            # Only a user can delegate acceptance; this fixture simulates that explicit UI action.
            setup = """
const s=require('./dist/knowledge/filestore');s.setStorePath(process.argv[1]);
let x=s.noteWorkItemsRead('Board');
for(const id of ['task','story']){
 const item=x.items.find(i=>i.id===id);
 x=s.noteWorkItemCommand('Board',x.digest,{action:'edit',item:{...item,reviewerIds:['mcp:external']},reason:'User delegates review'},{id:'user:local',role:'user'});
}
"""
            subprocess.run([node, "-e", setup, directory], cwd=ROOT, check=True)
            current = await call("get_board", **board)
            await write("submit_workitem_result", id="task", outcome="Success", evidence=["test://mcp"])
            await write("accept_workitem", id="task", reason="Explicit delegated review")
            await write("change_userstory_state", id="story", state="completed", outcome="Success", evidence=["test://story"])
            await write("accept_userstory", id="story", reason="Explicit Story review")
            await write("reopen_userstory", id="story", reason="Follow-up Story")
            changes = await call("list_board_changes", **board, limit=100)
            assert any(event["action"] == "delete" for event in changes["items"])
            assert {d["name"] for d in definitions} <= seen, {d["name"] for d in definitions} - seen
            await rejected("update_workitem", **board, id="task", expected_digest=current["digest"],
                           patch={"ownerId": "user:local"}, reason="Bypass")
            await rejected("get_board", **board, worker_token="0" * 64)
            # Distinct external identity is resolved from the token, never supplied actor fields.
            await write("add_workitem", item=item("distinct"))
            await write("assign_workitem", id="distinct", owner_id="external:claude:actual", reason="User-authorized worker")
            token_script = """
const s=require('./dist/knowledge/filestore');s.setStorePath(process.argv[1]);
const x=s.noteWorkItemsRead('Board');console.log(s.todoBoardGrantWorker('Board',x.digest,'external:claude:actual'));
"""
            token = subprocess.check_output([node, "-e", token_script, directory], cwd=ROOT, text=True).strip()
            current = await call("get_board", **board, worker_token=token)
            await write("claim_workitem", id="distinct", worker_token=token)
            assert current["actorId"] == "external:claude:actual"
            await call("todo_board_create", title="Other")
            other_board = {"board_slug": "Other"}
            other = await call("get_board", **other_board)
            other = await call("add_workitem", **other_board, expected_digest=other["digest"], item=item("next"))
            other = await call("assign_workitem", **other_board, expected_digest=other["digest"],
                               id="next", owner_id="external:claude:actual", reason="Same Agent on another Board")
            other_token = subprocess.check_output([
                node, "-e", token_script.replace("'Board'", "'Other'"), directory
            ], cwd=ROOT, text=True).strip()
            other = await call("get_board", **other_board, worker_token=other_token)
            await rejected("claim_workitem", expected_error="WORKITEM_FOCUS_CONFLICT", **other_board,
                           id="next", expected_digest=other["digest"], worker_token=other_token)
            assert (await call("get_board", **other_board))["digest"] == other["digest"]
            await rejected("change_workitem_state", expected_error="On hold reason", **board,
                           id="distinct", state="on-hold", expected_digest=current["digest"], worker_token=token)
            await write("change_workitem_state", id="distinct", state="on-hold",
                        reason="Explicitly pause before taking next work", worker_token=token)
            assert current["item"]["status"] == "on-hold"
            assert current["item"]["ownerId"] == "external:claude:actual"
            assert (await call("list_workitems", **board, states=["on-hold"]))["total"] == 1
            other = await call("claim_workitem", **other_board, expected_digest=other["digest"],
                               id="next", worker_token=other_token)
            await rejected("change_workitem_state", expected_error="WORKITEM_FOCUS_CONFLICT", **board,
                           id="distinct", state="active", expected_digest=current["digest"], worker_token=token)
            await rejected("note_work_item_command", expected_error="WORKITEM_FOCUS_CONFLICT",
                           slug="Board", expected_digest=current["digest"],
                           command={"action": "claim", "id": "distinct"}, worker_token=token)
            await call("submit_workitem_result", **other_board, expected_digest=other["digest"],
                       id="next", outcome="Success", evidence=["test://completed-next"], worker_token=other_token)
            await write("change_workitem_state", id="distinct", state="active", worker_token=token)
            assert current["item"]["ownerId"] == "external:claude:actual"
            print(f"PASS: {len(definitions)} named Todo APIs via real FastMCP, CAS, claims, audit and soft deletion")


if __name__ == "__main__":
    asyncio.run(main())
