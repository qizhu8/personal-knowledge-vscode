#!/usr/bin/env python3
import asyncio
import importlib.machinery
import importlib.util
import os
import json
import tempfile


root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
template = os.path.join(root, "resources", "chat_server.py.template")
loader = importlib.machinery.SourceFileLoader("generated_chat_template", template)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
cid_tempdir = tempfile.TemporaryDirectory()
module._cid_path = lambda: os.path.join(cid_tempdir.name, ".chat_cids.json")


async def main():
    assert module._recipient_names('@Host discusses `@all` behavior') == ["Host"]
    assert module._recipient_names('plain text mentions @all later') == []
    assert module._recipient_names('/release @"Agent One"') == ["Agent One"]
    assert module._all_mention_names('Conversation started for @"Agent One"') == ["Agent One"]
    assert module._mentions('@Host discusses `@all` behavior', "Generated Agent") is False

    tools = await module.mcp.list_tools()
    names = {tool.name for tool in tools}
    required = {"chat_capabilities", "chat_join", "chat_standby", "chat_post", "chat_status"}
    assert required <= names, required - names
    capability_tool = next(tool for tool in tools if tool.name == "chat_capabilities")
    assert "PKM Chatroom" in (capability_tool.description or "")
    assert module.chat_capabilities()["chat_tools"] == module.CHAT_TOOLS

    posted_frames = []
    posting = module.ChatConnection("Posting Agent", "ws://unused", "room", "secret", "room-posting")
    posting.status = "connected"
    posting.participant_id = "participant-posting"
    class FakeSocket:
        async def send(self, raw):
            posted_frames.append(json.loads(raw))
    posting.ws = FakeSocket()
    progress = await posting.post("@Host progress", continue_working=True)
    assert progress["ok"] is True and posting.runtime_state == "thinking"
    assert posted_frames[-1]["t"] == "agent.state" and posted_frames[-1]["state"] == "thinking"
    final = await posting.post("@Host complete")
    assert final["ok"] is True and posting.runtime_state == "standby"
    assert posted_frames[-1]["t"] == "agent.state" and posted_frames[-1]["state"] == "standby"

    connection = module.ChatConnection("Generated Agent", "ws://unused", "room", "secret", "room-generated")
    connection.status = "connected"
    connection.participant_id = "participant-generated"
    connection.record({"id": "g1", "from": "Generated Agent", "text": "@Host self", "ts": 1})
    connection.record({"id": "g2", "from": "Other", "text": "@Host unrelated", "ts": 2})
    connection.record({"id": "g3", "from": "Host", "text": '@"Generated Agent" act', "ts": 3})
    connection.record({"id": "g4", "from": "Host", "text": '@"Generated Agent" with this constraint', "ts": 4})
    result = await connection.standby(1)
    assert result["event"] == "message", result
    assert result["event_id"] == "g3"
    assert [item["id"] for item in result["messages"]] == ["g3", "g4"]
    assert result["event_ids"] == ["g3", "g4"]
    assert result["cursor_before"] == 0 and result["cursor_after"] == 4
    assert result["matched_mention"] == "Generated Agent"
    assert result["room_id"] == "room-generated"
    assert result["participant_id"] == "participant-generated"
    assert result["room_open"] is True
    assert result["should_continue_standby"] is True
    assert (await connection.standby(1))["event"] == "timeout"

    transport = module.ChatConnection("Transport Generated", "ws://unused", "room", "secret", "room-transport")
    transport.status = "disconnected"
    transport.error_code = "transport-error"
    transport.transport_error = "connection reset"
    transport_result = await transport.standby(1)
    assert transport_result["event"] == "transport_error", transport_result
    assert transport_result["retryable"] is True
    assert transport_result["room_open"] is True

    cancelled = module.ChatConnection("Cancelled Generated", "ws://unused", "room", "secret", "room-cancelled")
    cancelled.status = "connected"
    module._connections[cancelled.alias.casefold()] = cancelled
    cancelled_task = asyncio.create_task(module.chat_standby(timeout=30, name=cancelled.alias))
    await asyncio.sleep(0)
    cancelled_task.cancel()
    cancelled_result = json.loads(await cancelled_task)
    assert cancelled_result["event"] == "client_cancelled", cancelled_result
    assert cancelled_result["retryable"] is True
    assert cancelled_result["should_continue_standby"] is True
    module._connections.pop(cancelled.alias.casefold(), None)

    single = module.ChatConnection("Single Generated", "ws://unused", "room", "secret", "room-single")
    single.status = "connected"
    single.record({"id": "sg1", "from": "Host", "text": '@"Single Generated" first', "ts": 5})
    single.record({"id": "sg2", "from": "Host", "text": '@"Single Generated" second', "ts": 6})
    assert [item["id"] for item in (await single.standby(1, max_messages=1))["messages"]] == ["sg1"]
    assert [item["id"] for item in (await single.standby(1, max_messages=1))["messages"]] == ["sg2"]

    controlled = module.ChatConnection("Controlled Generated", "ws://unused", "room", "secret", "room-controlled")
    controlled.status = "connected"
    controlled.conversation_active = True
    controlled.record({"id": "cg1", "from": "Host", "text": '@"Controlled Generated" begin', "ts": 7})
    controlled.record({"id": "cg2", "from": "RoomBot", "text": "/stop_conversation — conversation stopped", "ts": 8})
    controlled_result = await controlled.standby(1)
    assert controlled_result["event"] == "stopped", controlled_result
    assert controlled_result["event_id"] == "cg2"
    assert controlled.conversation_active is False

    large = module.ChatConnection("Large Generated", "ws://unused", "room", "secret", "room-large")
    large.status = "connected"
    large.participant_id = "participant-large"
    large.record({"id": "g-large", "from": "Host", "text": '@"Large Generated" ' + ("界" * 5000), "ts": 9})
    limited = await large.standby(1, max_bytes=1024)
    assert limited["truncated"] is True
    assert limited["continuation_cursor"] == "g-large"
    assert len(limited["message"]["text"].encode("utf-8")) <= 1024
    assert len(json.dumps(limited, ensure_ascii=False).encode("utf-8")) <= 1400
    print("generated standby test: bounded burst, control precedence, identity metadata, and byte cap OK")


asyncio.run(main())