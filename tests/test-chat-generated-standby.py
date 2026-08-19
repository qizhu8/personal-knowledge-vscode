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
    assert module._recipient_names('/stop @"Agent One"') == ["Agent One"]
    assert module._all_mention_names('Conversation started for @"Agent One"') == ["Agent One"]
    assert module._mentions('@Host discusses `@all` behavior', "Generated Agent") is False
    assert module._structured_recipient_names('@Host report\n\n@"Agent B" @"Agent Three" review') == ["Host", "Agent B", "Agent Three"]
    assert module._structured_recipient_names('@Host report `@"Agent B"`\n```\n@"Agent Three"\n```') == ["Host", "Agent B", "Agent Three"]

    tools = await module.mcp.list_tools()
    names = {tool.name for tool in tools}
    required = {"chat_capabilities", "chat_join", "chat_standby", "chat_post", "chat_status"}
    assert required <= names, required - names
    capability_tool = next(tool for tool in tools if tool.name == "chat_capabilities")
    assert "PKM Chatroom" in (capability_tool.description or "")
    assert module.chat_capabilities()["chat_tools"] == module.CHAT_TOOLS

    class HoldingSocket:
        def __init__(self):
            self.release = asyncio.Event()
        def __aiter__(self):
            return self
        async def __anext__(self):
            if not self.release.is_set():
                self.release.set()
                return json.dumps({"t": "error", "code": "host-only-broadcast", "msg": "Host only."})
            await asyncio.Event().wait()

    nonfatal = module.ChatConnection("Nonfatal Agent", "ws://unused", "room", "secret", "room-nonfatal")
    nonfatal.status = "connected"
    nonfatal_socket = HoldingSocket()
    nonfatal.ws = nonfatal_socket
    nonfatal_reader = asyncio.create_task(nonfatal.reader(nonfatal_socket))
    await nonfatal_socket.release.wait()
    await asyncio.sleep(0)
    assert nonfatal.status == "connected", "message-level errors must not poison the connection"
    assert nonfatal.status_data()["room_open"] is True
    nonfatal_reader.cancel()
    try:
        await nonfatal_reader
    except asyncio.CancelledError:
        pass

    original_connection = module.ChatConnection
    original_parse = module._parse_magic_link
    stale_left = []
    class FailedReplacement:
        def __init__(self, alias, url, room, token, room_id):
            self.alias = alias
            self.error_code = "join-failed"
        async def start(self):
            raise RuntimeError("approval timeout")
        async def leave(self):
            stale_left.append("replacement")
    class StaleConnection:
        alias = "Retry Agent"
        async def leave(self):
            stale_left.append("stale")
    module._connections["retry agent"] = StaleConnection()
    module.ChatConnection = FailedReplacement
    module._parse_magic_link = lambda unused: ("ws://unused", "room", "secret", "room-retry")
    failed_join = json.loads(await module.chat_join("unused", "Retry Agent"))
    assert failed_join["ok"] is False and failed_join["active_aliases"] == [], failed_join
    assert stale_left == ["stale", "replacement"], stale_left
    module.ChatConnection = original_connection
    module._parse_magic_link = original_parse

    posted_frames = []
    posting = module.ChatConnection("Posting Agent", "ws://unused", "room", "secret", "room-posting")
    posting.status = "connected"
    posting.participant_id = "participant-posting"
    class FakeSocket:
        async def send(self, raw):
            frame = json.loads(raw)
            posted_frames.append(frame)
            if frame.get("t") == "msg":
                waiter = posting.post_waiters.get(frame.get("clientRequestId"))
                waiter.set_result({"ok": True, "posted": True, "client_request_id": frame["clientRequestId"], "message_id": "posted", "connection_alive": True})
    posting.ws = FakeSocket()
    progress = await posting.post("@Host progress", continue_working=True, require_reply=False)
    assert progress["ok"] is True and posting.runtime_state == "thinking"
    assert "Continue the current work" in progress["instruction"]
    assert posting.status_data()["runtime_state"] == "thinking"
    assert posting.status_data()["state_changed_at"] > 0
    assert posted_frames[-2]["requireReply"] is False
    assert posted_frames[-1]["t"] == "agent.state" and posted_frames[-1]["state"] == "thinking"
    final = await posting.post("@Host complete")
    assert final["ok"] is True and posting.runtime_state == "standby"
    assert posted_frames[-1]["t"] == "agent.state" and posted_frames[-1]["state"] == "standby"

    module._connections[posting.alias.casefold()] = posting
    atomic_post = asyncio.create_task(module.chat_post("@Host atomic final", name=posting.alias))
    await asyncio.sleep(0.02)
    assert not atomic_post.done(), "final chat_post must remain blocked in standby"
    posting.record({"id": "next-task", "from": "Host", "text": '@"Posting Agent" next task',
                    "ts": 1, "reply_required": True})
    atomic_result = json.loads(await asyncio.wait_for(atomic_post, timeout=1))
    assert atomic_result["posted"] is True and atomic_result["event"] == "message", atomic_result
    assert atomic_result["event_id"] == "next-task"
    module._connections.pop(posting.alias.casefold(), None)

    connection = module.ChatConnection("Generated Agent", "ws://unused", "room", "secret", "room-generated")
    connection.status = "connected"
    connection.participant_id = "participant-generated"
    connection.record({"id": "g1", "from": "Generated Agent", "text": "@Host self", "ts": 1})
    connection.record({"id": "g2", "from": "Other", "text": "@Host unrelated", "ts": 2})
    connection.record({"id": "g3", "from": "Host", "text": '@"Generated Agent" context only', "ts": 3, "reply_required": False})
    connection.record({"id": "g4", "from": "Host", "text": '@"Generated Agent" act', "ts": 4, "reply_required": True})
    result = await connection.standby(1)
    assert result["event"] == "message", result
    assert result["event_id"] == "g3"
    assert [item["id"] for item in result["messages"]] == ["g3", "g4"]
    assert result["event_ids"] == ["g3", "g4"]
    assert result["cursor_before"] == 0 and result["cursor_after"] == 4
    assert result["matched_mention"] == "Generated Agent"
    assert result["room_id"] == "room-generated"
    assert result["participant_id"] == "participant-generated"
    assert result["reply_required"] is True
    assert result["reply_required_event_ids"] == ["g4"]
    assert result["reply_audience"] == ["Host"]
    assert result["room_open"] is True
    assert result["should_continue_standby"] is True
    assert (await connection.standby(1))["event"] == "timeout"

    middle = module.ChatConnection("Middle Target", "ws://unused", "room", "secret", "room-middle")
    middle.status = "connected"
    middle.record({"id": "mid-1", "from": "Peer", "text": "context first, then @\"Middle Target\" review",
                   "ts": 5, "recipients": ["Middle Target"], "reply_policy": "required", "reply_required": True})
    middle_result = await middle.standby(1)
    assert middle_result["event"] == "message" and middle_result["event_id"] == "mid-1", middle_result
    assert middle_result["reply_required"] is True

    structured_only = module.ChatConnection("Structured Target", "ws://unused", "room", "secret", "room-structured")
    structured_only.status = "connected"
    structured_only.record({"id": "structured-1", "from": "Peer", "text": "no visible mention",
                            "ts": 6, "recipients": ["Structured Target"], "reply_policy": "none", "reply_required": False})
    structured_result = await structured_only.standby(1)
    assert structured_result["event"] == "message" and structured_result["reply_required"] is False, structured_result

    explicit_empty = module.ChatConnection("Empty Target", "ws://unused", "room", "secret", "room-empty")
    explicit_empty.status = "connected"
    explicit_empty.record({"id": "empty-1", "from": "Peer", "text": '@"Empty Target" visible but not routed',
                           "ts": 7, "recipients": [], "reply_policy": "required", "reply_required": True})
    assert (await explicit_empty.standby(1))["event"] == "timeout", "explicit empty recipients must override body text"

    self_message = module.ChatConnection("Self Target", "ws://unused", "room", "secret", "room-self")
    self_message.status = "connected"
    self_message.record({"id": "self-1", "from": "Self Target", "text": "self echo",
                         "ts": 8, "recipients": ["Self Target"], "reply_policy": "required", "reply_required": True})
    assert (await self_message.standby(1))["event"] == "timeout", "self-authored messages must not wake standby"

    spaced = module.ChatConnection("Agent With Spaces", "ws://unused", "room", "secret", "room-spaced")
    spaced.status = "connected"
    spaced.record({"id": "space-1", "from": "Peer", "text": 'details before @"Agent With Spaces" review',
                   "ts": 9, "recipients": ["agent with spaces"], "reply_policy": "required", "reply_required": True})
    spaced_result = await spaced.standby(1)
    assert spaced_result["event"] == "message" and spaced_result["matched_mention"] == "Agent With Spaces", spaced_result

    similar = module.ChatConnection("Agent With", "ws://unused", "room", "secret", "room-similar")
    similar.status = "connected"
    similar.record({"id": "similar-1", "from": "Peer", "text": '@"Agent With Spaces" only',
                    "ts": 10, "recipients": ["Agent With Spaces"], "reply_policy": "required", "reply_required": True})
    assert (await similar.standby(1))["event"] == "timeout", "similar alias prefixes must not cross-wake"

    group_frames = []
    group = module.ChatConnection("Group Generated", "ws://unused", "room", "secret", "room-group")
    group.status = "connected"
    class GroupSocket:
        async def send(self, raw):
            frame = json.loads(raw); group_frames.append(frame)
            if frame.get("t") == "msg":
                group.post_waiters[frame["clientRequestId"]].set_result({"ok": True, "posted": True, "client_request_id": frame["clientRequestId"], "message_id": "group-posted", "connection_alive": True})
    group.ws = GroupSocket()
    group.record({"id": "group-1", "from": "Host", "text": '@"Group Generated" @"Peer Agent" discuss',
                  "ts": 5, "reply_required": True})
    group_result = await group.standby(1)
    assert group_result["reply_audience"] == ["Host", "Peer Agent"], group_result
    await group.post("implicit group reply")
    group_post = next(frame for frame in group_frames if frame.get("t") == "msg")
    assert group_post["text"].startswith('@Host @"Peer Agent" '), group_post

    peer_frames = []
    peer = module.ChatConnection("Peer Agent", "ws://unused", "room", "secret", "room-peer")
    peer.status = "connected"
    class PeerSocket:
        async def send(self, raw):
            frame = json.loads(raw); peer_frames.append(frame)
            if frame.get("t") == "msg":
                peer.post_waiters[frame["clientRequestId"]].set_result({"ok": True, "posted": True, "client_request_id": frame["clientRequestId"], "message_id": "peer-posted", "connection_alive": True})
    peer.ws = PeerSocket()
    peer.record({"id": "group-2", "from": "Group Generated", "text": group_post["text"],
                 "ts": 6, "reply_required": True})
    peer_result = await peer.standby(1)
    assert peer_result["reply_audience"] == ["Group Generated", "Host"], peer_result
    await peer.post("peer continues")
    peer_post = next(frame for frame in peer_frames if frame.get("t") == "msg")
    assert peer_post["text"].startswith('@"Group Generated" @Host '), peer_post
    group.record({"id": "group-3", "from": "Peer Agent", "text": peer_post["text"],
                  "ts": 7, "reply_required": True})
    continued = await group.standby(1)
    assert continued["event"] == "message"
    assert continued["reply_audience"] == ["Peer Agent", "Host"], continued

    broadcast = module.ChatConnection("Broadcast Generated", "ws://unused", "room", "secret", "room-broadcast")
    broadcast.status = "connected"
    broadcast.record({"id": "broadcast-1", "from": "Host", "text": "@all FYI", "ts": 6,
                      "reply_required": False})
    broadcast_result = await broadcast.standby(1)
    assert broadcast_result["reply_audience"] == ["Host"], broadcast_result
    assert broadcast_result["reply_required"] is False

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
    controlled.status = "disconnected"
    controlled.terminal_event = {"event": "stopped", "reason": "Stopped by the room host.", "scope": "chatroom"}
    controlled_result = await controlled.standby(1)
    assert controlled_result["event"] == "stopped", controlled_result
    assert controlled_result["should_continue_standby"] is False
    assert controlled_result["scope"] == "chatroom"

    large = module.ChatConnection("Large Generated", "ws://unused", "room", "secret", "room-large")
    large.status = "connected"
    large.participant_id = "participant-large"
    large.record({"id": "g-large", "from": "Host", "text": '@"Large Generated" ' + ("界" * 5000), "ts": 9})
    limited = await large.standby(1, max_bytes=1024)
    assert limited["truncated"] is True
    assert limited["continuation_cursor"] == "g-large"
    assert len(limited["message"]["text"].encode("utf-8")) <= 1024
    assert len(json.dumps(limited, ensure_ascii=False).encode("utf-8")) <= 1400
    print("generated standby test: bounded burst, structured stop, identity metadata, and byte cap OK")


asyncio.run(main())