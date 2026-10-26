#!/usr/bin/env python3
"""Actual FastMCP-to-TypeScript transport tests, not native model E2E."""

import asyncio
import json
import pathlib
import sys
import tempfile

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources"))
from api_chat_control import register_api_chat_tools


HOST = r"""
const { ApiChatAgentControl } = require(process.argv[2]);
const { randomUUID } = require('crypto');
const pending = new Map(); let createCalls = 0; let sendCalls = 0; let portalCalls = 0;
const control = new ApiChatAgentControl(process.argv[1], { workspacePaths: ['/fixture'], build: { fingerprint: 'transport-fixture' } }, async (operation, args) => {
  if (operation === 'create') return { chatId: randomUUID(), title: args.title, createCalls: ++createCalls, sessionId: null };
  if (operation === 'send') { sendCalls++; return new Promise(resolve => pending.set(args.chatId, resolve)); }
  if (operation === 'get') return { running: pending.has(args.chatId), createCalls, sendCalls };
  if (operation === 'cancel') { pending.get(args.chatId)?.({ reply: { status: 'cancelled', credits: null } }); pending.delete(args.chatId); return { cancelled: true }; }
  if (operation === 'portal') return { ...args, portalCalls: ++portalCalls };
  return { createCalls, sendCalls };
});
process.on('SIGTERM', () => { control.dispose(); process.exit(0); });
process.stdin.resume(); console.log(control.hostId);
"""


async def launch(store):
    process = await asyncio.create_subprocess_exec(
        "node", "-e", HOST, str(store / ".pkm/state"), str(ROOT / "dist/chat/agent-control.js"),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    try:
        host_id = (await asyncio.wait_for(process.stdout.readline(), 5)).decode().strip()
        assert host_id, "TypeScript Host did not register"
        return process, host_id
    except BaseException:
        await stop(process)
        raise


async def stop(process):
    if process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


async def call(client, name, arguments):
    result = await client.call_tool(name, arguments)
    assert not result.is_error
    return json.loads(result.content[0].text)


async def receipt(client, request, expected):
    async def poll():
        while True:
            result = await call(client, "api_chat_request_get", {
                "host_id": request["host_id"], "request_id": request["request_id"]})
            if result["status"] == expected:
                return result
            assert result["status"] in {"queued", "running"}, result
            await asyncio.sleep(0.02)
    return await asyncio.wait_for(poll(), 5)


async def rejected(client, name, arguments, message):
    try:
        await client.call_tool(name, arguments)
    except ToolError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Invalid request was accepted")


async def main():
    with tempfile.TemporaryDirectory(prefix="pkm-chat-control-") as temporary:
        store = pathlib.Path(temporary)
        process, host_id = await launch(store)
        try:
            mcp = FastMCP("programmable-chat-test")
            register_api_chat_tools(mcp, store)
            async with Client(mcp) as client:
                catalog = await client.list_tools()
                assert len(catalog) == 9
                capabilities = await call(client, "api_chat_capabilities", {})
                assert capabilities["hosts"][0]["host_id"] == host_id
                assert capabilities["hosts"][0]["workspace_paths"] == ["/fixture"]
                requests = store / ".pkm/state/api-chat-control/requests" / host_id
                assert "portal_control" in capabilities["tools"]
                portal_args = {"host_id": host_id, "operation": "open", "command_id": "portal-once"}
                portal = await call(client, "portal_control", portal_args)
                opened = await receipt(client, portal, "succeeded")
                assert opened["result"]["portalCalls"] == 1
                assert await call(client, "portal_control", portal_args) == opened
                await rejected(client, "portal_control", {**portal_args, "operation": "status"}, "contextId")
                await rejected(client, "portal_control", {**portal_args, "operation": "execute"}, "Unsupported")
                await rejected(client, "portal_control", {**portal_args, "operation": "reattach"}, "Unsupported")
                portal_send = {**portal_args, "operation": "send", "command_id": "remote-test",
                               "context_id": host_id, "prompt": "Test the remote Windows installation",
                               "request_id": host_id}
                submitted_portal = await call(client, "portal_control", portal_send)
                routed = await receipt(client, submitted_portal, "succeeded")
                assert routed["result"]["contextId"] == host_id
                assert routed["result"]["requestId"] == host_id
                assert routed["result"]["prompt"] == portal_send["prompt"]
                await rejected(client, "portal_control", {**portal_send, "prompt": "Changed task"}, "different request")
                await rejected(client, "portal_control", {**portal_send, "request_id": "not-a-uuid"}, "UUID")
                files_args = {**portal_args, "command_id": "portal-file-batch", "operation": "files",
                              "context_id": host_id, "file_paths": ["/fixture/extension.vsix", "/fixture/checksums.txt"]}
                file_request = await call(client, "portal_control", files_args)
                file_receipt = await receipt(client, file_request, "succeeded")
                assert file_receipt["result"]["paths"] == files_args["file_paths"]
                await rejected(client, "portal_control", {**files_args, "file_paths": []}, "file_paths")
                await rejected(client, "portal_control", {**files_args, "operation": "status"}, "file_paths")
                host_record = json.loads((store / ".pkm/state/api-chat-control/hosts" / f"{host_id}.json").read_text())
                portal_directory = pathlib.Path(host_record["portalRequestDirectory"])
                assert portal_directory.is_absolute() and portal_directory.name.startswith("pkm-portal-ipc-")
                assert len(list(portal_directory.glob("*.json"))) == 3
                assert not list(requests.glob("*.json")), "Portal must not write receipts to Knowledge Root"
                (requests / ("0" * 64 + ".json")).write_text("{invalid", encoding="utf-8")
                create_args = {"host_id": host_id, "title": "Visible Agent QA", "command_id": "create-once"}
                submitted = await asyncio.gather(*(call(client, "api_chat_create", create_args) for _ in range(4)))
                assert len({request["request_id"] for request in submitted}) == 1
                created = await receipt(client, submitted[0], "succeeded")
                assert created["result"]["createCalls"] == 1
                assert created["result"]["sessionId"] is None
                chat_id = created["result"]["chatId"]
                chat_url = f"pkm://chats/0123456789abcdef/{chat_id}"
                create_file = requests / (created["request_id"] + ".json")
                original_bytes = create_file.read_bytes()
                assert await call(client, "api_chat_create", create_args) == created
                assert create_file.read_bytes() == original_bytes
                await rejected(client, "api_chat_create", {**create_args, "title": "Conflicting input"}, "different request")
                await rejected(client, "api_chat_create", {**create_args, "command_id": "bad-title", "title": ""}, "title must")
                send_args = {"host_id": host_id, "chat_id": chat_url, "prompt": "Explicit QA prompt", "command_id": "send-once"}
                sending = await call(client, "api_chat_send", send_args)
                await receipt(client, sending, "running")
                assert (await call(client, "api_chat_send", send_args))["request_id"] == sending["request_id"]
                query = await call(client, "api_chat_get", {"host_id": host_id, "chat_id": chat_url, "command_id": "get-while-running"})
                observed = await receipt(client, query, "succeeded")
                assert observed["result"] == {"running": True, "createCalls": 1, "sendCalls": 1}
                cancel = await call(client, "api_chat_cancel", {"host_id": host_id, "chat_id": chat_url, "command_id": "explicit-cancel"})
                await receipt(client, cancel, "succeeded")
                cancelled = await receipt(client, sending, "succeeded")
                assert cancelled["result"]["reply"]["status"] == "cancelled"
                assert cancelled["result"]["reply"]["credits"] is None
                legacy_query = await call(client, "api_chat_get", {"host_id": host_id, "chat_id": chat_id, "command_id": "legacy-id-query"})
                assert (await receipt(client, legacy_query, "succeeded"))["result"]["running"] is False
                for extra in [{}, {"command_id": ""}]:
                    read_request = await call(client, "api_chat_get", {"host_id": host_id, "chat_id": chat_url, **extra})
                    assert (await receipt(client, read_request, "succeeded"))["result"]["sendCalls"] == 1
                for name in ["api_chat_list", "api_chat_models"]:
                    await receipt(client, await call(client, name, {"host_id": host_id}), "succeeded")
                await rejected(client, "api_chat_get", {"host_id": "", "chat_id": chat_url}, "host_id returned by api_chat_capabilities")
                await rejected(client, "api_chat_get", {"host_id": "bad", "chat_id": chat_url}, "host_id returned by api_chat_capabilities")
                await rejected(client, "api_chat_send", {**send_args, "command_id": ""}, "command_id must contain")
                await rejected(client, "api_chat_create", {**create_args, "command_id": ""}, "command_id must contain")
                for invalid_url in [chat_url + "?host=other", chat_url + "/extra", f"pkm://chats/wrong/{chat_id}", f"pkm://notes/0123456789abcdef/{chat_id}"]:
                    await rejected(client, "api_chat_get", {"host_id": host_id, "chat_id": invalid_url, "command_id": "invalid-url"}, "PKM Chat URL")
                interrupted_args = {**send_args, "command_id": "interrupted-send"}
                interrupted = await call(client, "api_chat_send", interrupted_args)
                await receipt(client, interrupted, "running")
                await stop(process)
                assert not portal_directory.exists(), "Host disposal must remove temporary Portal IPC"
                await rejected(client, "api_chat_request_get", {"host_id": host_id, "request_id": portal["request_id"]}, "Host is offline")
                unknown = await receipt(client, interrupted, "outcome_unknown")
                assert (await call(client, "api_chat_send", interrupted_args))["status"] == "outcome_unknown"
                record = json.loads((requests / (unknown["request_id"] + ".json")).read_text())
                assert record["status"] == "running", "Offline observation must not mutate or replay the request"
                await rejected(client, "api_chat_send", {**send_args, "command_id": "offline-new-send"}, "Host is offline")
                assert await call(client, "api_chat_create", create_args) == created
                process, successor = await launch(store)
                assert successor != host_id
                query = await call(client, "api_chat_list", {"host_id": successor, "command_id": "new-host-no-replay"})
                observed = await receipt(client, query, "succeeded")
                assert observed["result"] == {"createCalls": 0, "sendCalls": 0}
                assert (await call(client, "api_chat_request_get", {"host_id": host_id, "request_id": interrupted["request_id"]}))["status"] == "outcome_unknown"
        finally:
            await stop(process)
    print("Actual MCP/TypeScript transport passed: concurrent idempotency, conflicting input, malformed queue, live query/cancel, offline uncertainty and no reload replay.")


if __name__ == "__main__":
    asyncio.run(main())