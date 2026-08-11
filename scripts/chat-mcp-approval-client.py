#!/usr/bin/env python3
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from chat_server import ChatBridge


url, room, room_id, secret, alias = sys.argv[1:6]
mode = sys.argv[6] if len(sys.argv) > 6 else "join"
bridge = ChatBridge()
bridge.configure(url, secret, alias, room=room, room_id=room_id)
started = time.monotonic()
bridge.start()
ok, error = bridge.wait_for_join(10)
result = {"ok": ok, "error": error, "elapsed": time.monotonic() - started,
          "participant_id": bridge.participant_id, "state": bridge.state,
          "runtime_state": bridge.runtime_state}
if ok and mode in ("standby", "stop", "history", "inactive-stop", "closed"):
    event = bridge.standby(1 if mode in ("history", "inactive-stop") else 5)
    result["standby_event"] = event.get("event")
    if mode == "standby" and event.get("event") == "message":
        bridge.send_state("sending")
        result["post_ok"] = bridge.send_text("directed response")[0]
        bridge.send_state("standby")
        time.sleep(0.1)
        result["runtime_state"] = bridge.runtime_state
    else:
        result["runtime_state"] = bridge.runtime_state
print(json.dumps(result), flush=True)