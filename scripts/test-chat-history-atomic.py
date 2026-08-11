#!/usr/bin/env python3
import os
import sys
import threading
import time
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from chat_server import ChatBridge


bridge = ChatBridge()
bridge.name = "History Agent"
bridge.state = "joined"
result = {}


def wait():
    result.update(bridge.standby(1))


thread = threading.Thread(target=wait)
thread.start()
time.sleep(0.05)
bridge._on_frame(__import__("json").dumps({
    "t": "history",
    "messages": [
        {"from": "roombot", "text": "Conversation started — active agents: @\"History Agent\".", "ts": 1},
        {"from": "Host", "text": "/release @\"History Agent\"", "ts": 2},
        {"from": "Host", "text": "/stop_conversation", "ts": 3},
        {"system": True, "from": "", "text": "History Agent left the room", "ts": 4},
    ],
}))
thread.join(timeout=2)

assert not thread.is_alive(), "standby test thread did not finish"
assert result.get("event") == "timeout", result
assert bridge.runtime_state == "standby", bridge.runtime_state
assert bridge.conversation_active is False
assert bridge.standby_cursor == bridge.seq == 4

catchup = ChatBridge()
catchup.name = "Catchup Agent"
catchup.state = "joined"
directed_result = {}


def wait_directed():
    directed_result.update(catchup.standby(1))


directed_thread = threading.Thread(target=wait_directed)
directed_thread.start()
time.sleep(0.05)
catchup._on_frame(__import__("json").dumps({
    "t": "history",
    "mode": "catchup",
    "messages": [
        {"id": "c1", "from": "roombot", "text": "Conversation started — active agents: @\"Catchup Agent\".", "ts": 5},
        {"id": "c2", "from": "Host", "text": "@\"Catchup Agent\" please catch up", "ts": 6},
    ],
}))
directed_thread.join(timeout=2)
assert directed_result.get("event") == "message", directed_result
assert catchup.conversation_active is True
assert catchup.last_message_id == "c2"

stopped_result = {}


def wait_stopped():
    stopped_result.update(catchup.standby(1))


stopped_thread = threading.Thread(target=wait_stopped)
stopped_thread.start()
time.sleep(0.05)
catchup._on_frame(__import__("json").dumps({
    "t": "history",
    "mode": "catchup",
    "messages": [{"id": "c3", "from": "Host", "text": "/stop_conversation", "ts": 7}],
}))
stopped_thread.join(timeout=2)
assert stopped_result.get("event") == "stopped", stopped_result
assert catchup.runtime_state == "idle"
assert catchup.last_message_id == "c3"

focused = ChatBridge()
focused.name = "Focused Agent"
focused.room_id = "room-focused"
focused.participant_id = "participant-focused"
focused.state = "joined"
focused._replace_history([
    {"id": "f1", "from": "Focused Agent", "text": "@Host my own post", "ts": 8},
    {"id": "f2", "from": "Other", "text": "@Host unrelated", "ts": 9},
    {"id": "f3", "from": "Host", "text": "@\"Focused Agent\" do this", "ts": 10},
    {"id": "f4", "from": "Host", "text": "@\"Focused Agent\" with this additional constraint", "ts": 11},
], mode="catchup")
focused_result = focused.standby(1)
assert focused_result["event"] == "message", focused_result
assert focused_result["event_id"] == "f3"
assert focused_result["message"]["id"] == "f3"
assert focused_result["event_ids"] == ["f3", "f4"]
assert [item["id"] for item in focused_result["messages"]] == ["f3", "f4"]
assert focused_result["addressed"] is True
assert focused_result["matched_mention"] == "Focused Agent"
assert focused_result["cursor_before"] == 0
assert focused_result["cursor_after"] == 4
assert focused_result["truncated"] is False
assert focused_result["room_id"] == "room-focused"
assert focused_result["participant_id"] == "participant-focused"
assert focused_result["conversation_active"] is False
assert focused_result["room_open"] is True
assert focused_result["should_continue_standby"] is True
assert focused_result["room_closed"] is False
assert focused.standby(1)["event"] == "timeout", "consumed self/non-directed/trigger messages must not replay"

transport = ChatBridge()
transport.name = "Transport Agent"
transport.state = "disconnected"
transport.error_code = "transport-error"
transport.transport_error = "connection reset"
transport_result = transport.standby(1)
assert transport_result["event"] == "transport_error", transport_result
assert transport_result["retryable"] is True
assert transport_result["room_open"] is True
assert transport_result["should_continue_standby"] is True

single = ChatBridge()
single.name = "Single Agent"
single._replace_history([
    {"id": "s1", "from": "Host", "text": "@\"Single Agent\" first", "ts": 12},
    {"id": "s2", "from": "Host", "text": "@\"Single Agent\" second", "ts": 13},
], mode="catchup")
assert [item["id"] for item in single.standby(1, max_messages=1)["messages"]] == ["s1"]
assert [item["id"] for item in single.standby(1, max_messages=1)["messages"]] == ["s2"]

controlled = ChatBridge()
controlled.name = "Controlled Agent"
controlled.conversation_active = True
controlled._replace_history([
    {"id": "ctrl1", "from": "Host", "text": "@\"Controlled Agent\" begin", "ts": 14},
    {"id": "ctrl2", "from": "Host", "text": "/stop_conversation", "ts": 15},
], mode="catchup")
controlled_result = controlled.standby(1)
assert controlled_result["event"] == "stopped", controlled_result
assert controlled_result["event_id"] == "ctrl2"
assert controlled.conversation_active is False

large = ChatBridge()
large.name = "Large Agent"
large.room_id = "room-large"
large.participant_id = "participant-large"
large._replace_history([{"id": "large-1", "from": "Host", "text": "@\"Large Agent\" " + ("界" * 5000), "ts": 16}], mode="catchup")
large_result = large.standby(1, max_bytes=1024)
assert large_result["event_id"] == "large-1"
assert large_result["truncated"] is True
assert large_result["continuation_cursor"] == "large-1"
assert len(large_result["message"]["text"].encode("utf-8")) <= 1024
assert len(json.dumps(large_result, ensure_ascii=False).encode("utf-8")) <= 1400

print("history atomic test: bounded burst, control precedence, cursor metadata, and byte cap OK")