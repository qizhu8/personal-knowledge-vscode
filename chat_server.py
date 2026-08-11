#!/usr/bin/env python3
"""
pkm-chat — an MCP server that lets an AI agent join a Personal Knowledge Manager
"Agent Chatroom" and read / post messages.

The room host shares one pkchat:v1 Magic Link and assigns the agent an alias.

Wire this file into your agent as an MCP server, e.g. in an MCP client config:

    {
            "servers": {
        "pkm-chat": {
                    "type": "stdio",
                    "command": "/absolute/path/to/python3",
                    "args": ["/path/to/chat_server.py"]
        }
      }
    }

Install:  pip install fastmcp websockets
Run:      python chat_server.py

Tools exposed to the agent:
    chat_join(magic_link, name)   join from one Magic Link + assigned alias
    chat_status()            connection + room status
    chat_poll(max=50)        NEW messages since the last poll (advances a cursor)
    chat_standby(timeout=300) block until @mentioned/granted a turn or stopped
    chat_history(limit=50)   recent buffered messages (no cursor change)
    chat_send(text)          post a message ('/...' runs a room command)
    chat_who()               current members present in the room
    chat_reconnect()         retry the current Magic Link connection

STANDARD PROCEDURE for an agent asked to join:
    1. Obtain the host's pkchat:v1 Magic Link and the alias assigned to you.
    2. Call chat_join(magic_link=..., name=...). Do not ask for URL/key separately.
        3. Approval automatically sets standby. Call chat_standby to block until an
             @message addresses you. chat_send returns to standby automatically; call
             chat_standby again to keep waiting until stop/release/leave/Room close.

Note: stdout is reserved for the MCP protocol — all logs go to stderr.
"""
import sys
import json
import time
import asyncio
import secrets
import threading
import base64
import hashlib
import re
from collections import deque
from urllib.parse import urlsplit, unquote

try:
    import websockets
except ImportError:
    raise SystemExit("websockets not found. Run: pip install websockets")
try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")
try:
    # protocol.py should sit beside this file; degrade gracefully if absent.
    from protocol import parse_mentions, parse_recipients, mentions_name
except Exception:
    def parse_mentions(_text):
        return []

    def parse_recipients(_text):
        return []

    def mentions_name(_text, _name):
        return False


def _log(*a):
    print("[pkm-chat]", *a, file=sys.stderr, flush=True)


# A stable identity for this process so reconnects merge instead of creating ghosts.
CID = secrets.token_hex(8)

# Fatal error codes from the hub — don't reconnect until the user intervenes.
FATAL_CODES = {"auth", "name-taken", "no-room", "room-mismatch", "join-rejected", "join-timeout", "join-cancelled"}


def _has_any_mention(text):
    return bool(re.search(r'@(?:"[^"\n]{1,60}"|[\w-]{1,60})', str(text or "")))


def _format_mention(name):
    value = str(name or "").replace('"', "").strip()
    return "@" + value if re.fullmatch(r"[A-Za-z0-9_][\w-]{0,59}", value) else '@"' + value + '"'


def parse_magic_link(value):
    raw = str(value or "").strip()
    if not raw.startswith("pkchat:v1:"):
        raise ValueError("Chat Magic Link must start with pkchat:v1:")
    try:
        payload, checksum = raw[len("pkchat:v1:"):].split(".", 1)
    except ValueError:
        raise ValueError("Chat Magic Link format is invalid or incomplete.")
    expected = base64.urlsafe_b64encode(hashlib.sha256(payload.encode()).digest()).decode().rstrip("=")[:16]
    if checksum != expected:
        raise ValueError("Chat Magic Link checksum failed. It may have been copied incorrectly.")
    try:
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode())
    except Exception:
        raise ValueError("Chat Magic Link payload is invalid.")
    url, secret = str(decoded.get("u") or "").strip(), str(decoded.get("s") or "").strip()
    room_id = str(decoded.get("r") or "").strip()
    parsed = urlsplit(url)
    if decoded.get("v") != 1 or parsed.scheme not in ("ws", "wss") or not parsed.netloc or not parsed.path.strip("/") or not secret:
        raise ValueError("Chat Magic Link is missing valid room credentials.")
    return url, secret, room_id


class ChatBridge:
    """Owns a background asyncio loop that keeps one WebSocket connection to the
    hub alive (with reconnect/backoff) and buffers inbound messages for polling."""

    def __init__(self):
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.loop = None
        self.url = ""
        self.room = ""
        self.name = ""
        self.secret = ""
        self.room_id = ""
        self.state = "idle"   # idle|connecting|joined|disconnected|closed|error
        self.error = "no meeting configured — call chat_join(magic_link, name)"
        self.error_code = "not-configured"
        self.members = []
        self.buf = deque(maxlen=2000)   # {seq,type,from,text,ts}
        self.seq = 0
        self.cursor = 0
        self.standby_cursor = 0
        self.conversation_active = False
        self.runtime_state = "standby"
        self.participant_id = ""
        self.reply_target = ""
        self.last_message_id = ""
        self.terminal_event = None
        self.transport_error = ""
        self._outbox = None
        self._resume = None
        self._stop = False
        self._fatal = True

    # ── background thread / event loop ──────────────────────────────────────
    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._main())
        except Exception as e:  # pragma: no cover
            _log("loop crashed:", e)

    async def _main(self):
        self._outbox = asyncio.Queue()
        self._resume = asyncio.Event()
        backoff = 1
        while not self._stop:
            if self._fatal:
                _log("paused:", self.error or "fatal error", "— call chat_reconnect to retry")
                await self._resume.wait()
                self._resume.clear()
                self._fatal = False
                backoff = 1
                if self._stop:
                    break
            try:
                with self.lock:
                    self.state = "connecting"
                async with websockets.connect(self.url, max_size=2 ** 22, ping_interval=20, ping_timeout=20) as ws:
                    with self.changed:
                        self.transport_error = ""
                    await ws.send(json.dumps({
                        "t": "join", "room": self.room, "user": self.name,
                        "roomId": self.room_id or None, "token": self.secret, "kind": "agent", "cid": CID,
                        "resumeAfter": self.last_message_id or None,
                    }))
                    sender = asyncio.ensure_future(self._sender(ws))
                    try:
                        async for raw in ws:
                            self._on_frame(raw)
                            backoff = 1
                    finally:
                        sender.cancel()
                with self.lock:
                    if self.state not in ("closed", "error"):
                        self.state = "disconnected"
                if not self._fatal:
                    with self.changed:
                        self.transport_error = "WebSocket disconnected before the Room closed."
                        self.changed.notify_all()
            except Exception as e:
                with self.changed:
                    self.state = "disconnected"
                    self.error = str(e)
                    self.error_code = "transport-error"
                    self.transport_error = self.error or "WebSocket transport failed."
                    self.changed.notify_all()
            if self._stop or self._fatal:
                continue
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _sender(self, ws):
        while True:
            item = await self._outbox.get()
            try:
                await ws.send(json.dumps(item))
            except Exception:
                return

    # ── inbound frames ──────────────────────────────────────────────────────
    def _add(self, typ, frm, text, ts, message_id=""):
        if text == "" and typ == "chat":
            return
        # Flag @mentions of *this* agent (ignore our own messages).
        mentions, mentioned = [], False
        if typ == "chat" and frm != self.name:
            try:
                mentions = parse_mentions(text) if frm == "roombot" else parse_recipients(text)
                mentioned = mentions_name(text, self.name)
            except Exception:
                pass
        with self.changed:
            self.seq += 1
            self.buf.append({"seq": self.seq, "id": message_id, "type": typ, "from": frm, "text": text,
                             "ts": ts, "mentioned": mentioned, "mentions": mentions})
            if message_id:
                self.last_message_id = message_id
            self.changed.notify_all()

    def _replace_history(self, messages, mode="baseline"):
        """Append one history frame atomically; only baseline advances cursors."""
        with self.changed:
            for item in messages:
                text = str(item.get("text") or "")
                typ = "system" if item.get("system") else "chat"
                if text == "" and typ == "chat":
                    continue
                frm = str(item.get("from") or "")
                mentions, mentioned = [], False
                if typ == "chat" and frm != self.name:
                    try:
                        mentions = parse_mentions(text) if frm == "roombot" else parse_recipients(text)
                        mentioned = mentions_name(text, self.name)
                    except Exception:
                        pass
                self.seq += 1
                message_id = str(item.get("id") or "")
                self.buf.append({"seq": self.seq, "id": message_id, "type": typ, "from": frm, "text": text,
                                 "ts": item.get("ts", 0), "mentioned": mentioned, "mentions": mentions})
                if message_id:
                    self.last_message_id = message_id
            if mode != "catchup":
                self.cursor = self.seq
                self.standby_cursor = self.seq
            self.changed.notify_all()

    def _on_frame(self, raw):
        try:
            f = json.loads(raw)
        except Exception:
            return
        t = f.get("t")
        now = int(time.time() * 1000)
        if t == "msg":
            receipt = f.get("receipt") or {}
            if receipt.get("ack") and f.get("id") and self.loop is not None and self._outbox is not None:
                try:
                    asyncio.run_coroutine_threadsafe(
                        self._outbox.put({"t": "msg.read", "room": self.room, "messageId": f["id"]}), self.loop)
                except Exception:
                    pass
            self._add("chat", f.get("from", ""), f.get("text", ""), f.get("ts") or now, str(f.get("id") or ""))
        elif t == "system":
            self._add("system", "", f.get("text", ""), f.get("ts") or now)
        elif t == "history":
            self._replace_history(f.get("messages", []), f.get("mode", "baseline"))
        elif t == "presence":
            with self.lock:
                self.members = f.get("members", [])
        elif t == "join.pending":
            with self.changed:
                self.state = "waiting-approval"
                self.error = "Waiting for Host approval"
                self.changed.notify_all()
        elif t == "join.approved":
            with self.changed:
                self.participant_id = str(f.get("participantId") or "")
        elif t == "join.ready":
            with self.changed:
                self.state = "joined"
                self.error = ""
                self.error_code = ""
                self.changed.notify_all()
            self.send_state("standby")
        elif t == "rekey":
            with self.lock:
                self.secret = f.get("secret", self.secret)
            _log("host rotated the room secret; adopted the new one")
        elif t == "error":
            code, msg = f.get("code", ""), f.get("msg", "")
            with self.lock:
                self.error = f"{code}: {msg}"
                self.error_code = code
            _log("hub error:", self.error)
            if code in FATAL_CODES:
                self._fatal = True
                with self.lock:
                    self.state = "error"
            with self.changed:
                self.changed.notify_all()
        elif t in ("closed", "kicked"):
            reason = f.get("reason", "")
            with self.lock:
                self.state = "closed"
                self.error = (("kicked: " if t == "kicked" else "") + reason).strip()
            self._fatal = True
            with self.changed:
                self.terminal_event = {"event": "kicked" if t == "kicked" else "closed",
                                       "reason": self.error or reason}
                self.error_code = "kicked" if t == "kicked" else "room-closed"
                self.transport_error = ""
                self.changed.notify_all()

    # ── thread-safe API for the MCP tools ───────────────────────────────────
    def send_text(self, text):
        text = (text or "").strip()
        if not text:
            return False, "empty message"
        if self.loop is None or self._outbox is None:
            return False, "not connected yet"
        with self.lock:
            if self.state not in ("joined", "connecting", "disconnected"):
                return False, f"cannot send while {self.state}: {self.error}"
            if not text.startswith("/") and not _has_any_mention(text) and self.reply_target:
                text = f"{_format_mention(self.reply_target)} {text}"
            self.reply_target = ""
        try:
            fut = asyncio.run_coroutine_threadsafe(
                self._outbox.put({"t": "msg", "room": self.room, "text": text[:8000]}), self.loop)
            fut.result(timeout=5)
            return True, ""
        except Exception as e:
            return False, str(e)

    def send_state(self, state):
        with self.lock:
            self.runtime_state = state
        if self.loop is None or self._outbox is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(
                self._outbox.put({"t": "agent.state", "room": self.room, "state": state}), self.loop)
        except Exception:
            pass

    def poll(self, mx):
        with self.lock:
            new = [m for m in self.buf if m["seq"] > self.cursor]
            if new:
                self.cursor = new[-1]["seq"]
            if mx and len(new) > mx:
                new = new[-mx:]
            return list(new)

    def history(self, limit):
        with self.lock:
            items = list(self.buf)
            return items[-limit:] if limit else items

    def status(self):
        with self.lock:
            unread_mentions = sum(1 for m in self.buf
                                  if m.get("mentioned") and m["seq"] > self.cursor)
            return {
                "state": self.state, "room": self.room, "name": self.name, "url": self.url,
                "members": len(self.members), "error": self.error,
                "error_code": self.error_code,
                "buffered": len(self.buf), "unread": max(0, self.seq - self.cursor),
                "unread_mentions": unread_mentions,
                "participant_id": self.participant_id,
                **self._lifecycle_fields(),
            }

    def _lifecycle_fields(self, event=""):
        room_closed = event in ("closed", "kicked") or self.state == "closed"
        room_open = not room_closed and self.state != "error"
        should_continue = room_open and event not in ("stopped", "released")
        return {
            "conversation_active": self.conversation_active,
            "room_open": room_open,
            "should_continue_standby": should_continue,
            "room_closed": room_closed,
            "new_link_required": room_closed or self.error_code in ("auth", "no-room", "room-mismatch"),
        }

    def wait_for_join(self, timeout=125):
        deadline = time.monotonic() + timeout
        with self.changed:
            while self.state not in ("joined", "error", "closed"):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._stop = True
                    return False, "Host approval did not complete within 125 seconds."
                self.changed.wait(timeout=remaining)
            return self.state == "joined", self.error

    def mentions(self, limit):
        with self.lock:
            hits = [m for m in self.buf if m.get("mentioned")]
            return hits[-limit:] if limit else hits

    def standby(self, timeout=300, max_messages=8, max_bytes=32768, batch_wait_ms=250):
        """Block until directed, or until an active conversation stops/releases this Agent."""
        self.send_state("standby")
        max_messages = max(1, min(int(max_messages or 8), 32))
        max_bytes = max(1024, min(int(max_bytes or 32768), 65536))
        batch_wait_ms = max(0, min(int(batch_wait_ms or 0), 1000))
        deadline = time.monotonic() + max(1, min(int(timeout or 300), 1800))
        with self.changed:
            cursor_before = self.standby_cursor
            while True:
                if self.terminal_event:
                    terminal = self.terminal_event
                    self.terminal_event = None
                    self.runtime_state = "idle"
                    return {**terminal, "message": None, "messages": [], "event_id": "",
                            "cursor_before": cursor_before, "cursor_after": self.standby_cursor,
                            "addressed": False, "matched_mention": "", "truncated": False,
                            "continuation_cursor": "", "room_id": self.room_id,
                            "participant_id": self.participant_id,
                            **self._lifecycle_fields(terminal.get("event", "")),
                            "instruction": "Room participation ended. Return control to the user."}
                if self.transport_error:
                    reason = self.transport_error
                    self.transport_error = ""
                    return {"event": "transport_error", "reason": reason, "retryable": True,
                            "message": None, "messages": [], "event_id": "", "event_ids": [],
                            "cursor_before": cursor_before, "cursor_after": self.standby_cursor,
                            "addressed": False, "matched_mention": "", "truncated": False,
                            "continuation_cursor": "", "room_id": self.room_id,
                            "participant_id": self.participant_id,
                            **self._lifecycle_fields("transport_error"),
                            "instruction": "Transport was interrupted. The client is reconnecting; call chat_standby again."}
                pending = [m for m in self.buf if m["seq"] > self.standby_cursor]
                for message in pending:
                    text = str(message.get("text") or "").strip()
                    low = text.lower()
                    names = [str(name).lower() for name in (message.get("mentions") or [])]
                    self.standby_cursor = message["seq"]
                    started = message.get("from") == "roombot" and "conversation started" in low
                    joined = message.get("from") == "roombot" and "joined the conversation" in low
                    if (started or joined) and (self.name.lower() in names or "all" in names or "everyone" in names):
                        self.conversation_active = True
                        self.send_state("standby")
                        continue
                    if self.conversation_active and (low.startswith("/stop_conversation") or "conversation stopped" in low):
                        self.conversation_active = False
                        self.send_state("idle")
                        return self._standby_result("stopped", message, cursor_before, False, "", max_bytes,
                                                    "Conversation ended. Return control to the user.")
                    if self.conversation_active and low.startswith("/release") and self.name.lower() in names:
                        self.conversation_active = False
                        self.send_state("idle")
                        return self._standby_result("released", message, cursor_before, True, self.name, max_bytes,
                                                    "You were released. Return control to the user.")
                    if message.get("from") == self.name:
                        continue
                    directed = self.name.lower() in names or "all" in names or "everyone" in names
                    granted = message.get("from") == "roombot" and directed and "your turn" in low
                    direct_message = message.get("from") != "roombot" and directed
                    if granted or direct_message:
                        if message.get("from") != "roombot":
                            self.reply_target = message.get("from", "")
                        else:
                            self.reply_target = next((item.get("from", "") for item in reversed(pending)
                                                      if item.get("from") not in ("", "roombot", self.name)), "Host")
                        self.send_state("thinking")
                        matched = "all" if "all" in names else "everyone" if "everyone" in names else self.name
                        messages, control = self._collect_directed_batch(message, max_messages, batch_wait_ms)
                        if control:
                            kind, control_message = control
                            self.conversation_active = False
                            self.send_state("idle")
                            return self._standby_result(
                                kind, control_message, cursor_before, kind == "released", self.name if kind == "released" else "",
                                max_bytes, "Conversation ended. Return control to the user.")
                        if self.terminal_event:
                            terminal = self.terminal_event
                            self.terminal_event = None
                            self.runtime_state = "idle"
                            return {**terminal, "message": None, "messages": [], "event_id": "",
                                    "cursor_before": cursor_before, "cursor_after": self.standby_cursor,
                                    "addressed": False, "matched_mention": "", "truncated": False,
                                    "continuation_cursor": "", "room_id": self.room_id,
                                    "participant_id": self.participant_id,
                                    **self._lifecycle_fields(terminal.get("event", "")),
                                    "instruction": "Room participation ended. Return control to the user."}
                        return self._standby_result(
                            "message", messages, cursor_before, True, matched, max_bytes,
                            "Respond to this directed message batch with chat_send, then immediately call chat_standby again.")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.send_state("standby")
                    return {
                        "event": "timeout", "message": None, "messages": [], "event_id": "",
                        "cursor_before": cursor_before, "cursor_after": self.standby_cursor,
                        "addressed": False, "matched_mention": "", "truncated": False,
                        "continuation_cursor": "", "room_id": self.room_id,
                        "participant_id": self.participant_id,
                        **self._lifecycle_fields("timeout"),
                        "instruction": "Still in standby. Call chat_standby again to keep waiting.",
                    }
                self.changed.wait(timeout=remaining)

    def _collect_directed_batch(self, first, max_messages, batch_wait_ms):
        """Collect immediately-following directed messages during a short bounded burst window."""
        selected = [first]
        deadline = time.monotonic() + (batch_wait_ms / 1000.0)
        while len(selected) < max_messages:
            if self.terminal_event:
                return selected, None
            candidates = [item for item in self.buf if item["seq"] > self.standby_cursor]
            for item in candidates:
                self.standby_cursor = item["seq"]
                text = str(item.get("text") or "").strip()
                low = text.lower()
                names = [str(name).lower() for name in (item.get("mentions") or [])]
                if self.conversation_active and (low.startswith("/stop_conversation") or "conversation stopped" in low):
                    return selected, ("stopped", item)
                if self.conversation_active and low.startswith("/release") and self.name.lower() in names:
                    return selected, ("released", item)
                if item.get("from") == self.name:
                    continue
                if self.name.lower() in names or "all" in names or "everyone" in names:
                    selected.append(item)
                    if len(selected) >= max_messages:
                        return selected, None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            self.changed.wait(timeout=remaining)
        return selected, None

    def _standby_result(self, event, messages, cursor_before, addressed, matched_mention, max_bytes, instruction):
        """Build a bounded event response while the caller holds self.changed."""
        source_messages = messages if isinstance(messages, list) else [messages]
        result_messages = [dict(item) for item in source_messages]
        encoded = json.dumps(result_messages, ensure_ascii=False).encode("utf-8")
        truncated = len(encoded) > max_bytes
        if truncated:
            budget = max(0, max_bytes - 1024)
            kept = []
            for item in result_messages:
                candidate = json.dumps(kept + [item], ensure_ascii=False).encode("utf-8")
                if len(candidate) <= budget:
                    kept.append(item)
                    continue
                if not kept:
                    text = str(item.get("text") or "").encode("utf-8")
                    item["text"] = text[:budget].decode("utf-8", "ignore")
                    item["truncated_bytes"] = len(encoded)
                    kept.append(item)
                break
            result_messages = kept
        first = source_messages[0]
        last = source_messages[-1]
        return {
            "event": event,
            "message": result_messages[0] if result_messages else None,
            "messages": result_messages,
            "event_id": str(first.get("id") or ""),
            "event_ids": [str(item.get("id") or "") for item in source_messages],
            "cursor_before": cursor_before,
            "cursor_after": self.standby_cursor,
            "addressed": addressed,
            "matched_mention": matched_mention,
            "truncated": truncated,
            "continuation_cursor": str(last.get("id") or "") if truncated else "",
            "room_id": self.room_id,
            "participant_id": self.participant_id,
            **self._lifecycle_fields(event),
            "instruction": instruction,
        }

    def configure(self, url, secret, name=None, room=None, room_id=""):
        """Point the bridge at a room and (re)connect. Returns the new status."""
        url = (url or "").strip()
        secret = (secret or "").strip()
        if not url or not secret:
            return {"ok": False, "error": "url and secret are required", **self.status()}
        with self.lock:
            self.url = url
            self.secret = secret
            self.room_id = str(room_id or "")
            if name:
                self.name = name.strip()[:60] or self.name
            self.room = (room or "").strip() or unquote(urlsplit(url).path.lstrip("/"))
            self.error = ""
            self.error_code = ""
            self.transport_error = ""
            self.cursor = self.seq  # don't replay old room's buffer as "new"
            self.standby_cursor = self.seq
            self.conversation_active = False
            self.runtime_state = "standby"
        self._fatal = False
        if self.loop and self._resume:
            self.loop.call_soon_threadsafe(self._resume.set)
        return {"ok": True, **self.status()}

    def reconnect(self):
        self._fatal = False
        with self.lock:
            self.error = ""
            self.error_code = ""
            self.transport_error = ""
        if self.loop and self._resume:
            self.loop.call_soon_threadsafe(self._resume.set)
        return self.status()


bridges = {}


def _aliases():
    return sorted(bridge.name for bridge in bridges.values())


def _resolve_bridge(name=""):
    requested = str(name or "").strip().casefold()
    matches = [bridge for key, bridge in bridges.items()
               if not requested or requested in (key, bridge.name.casefold())]
    if requested and not matches:
        raise ValueError(f"No joined Chatroom identity matches {name!r}. Active aliases: {', '.join(_aliases()) or 'none'}")
    if not requested and len(matches) > 1:
        raise ValueError(f"Multiple Chatroom identities are active. Pass name=your_assigned_alias. Active aliases: {', '.join(_aliases())}")
    if not matches:
        raise ValueError("No Chatroom identity is joined. Call chat_join first.")
    return matches[0]


mcp = FastMCP("pkm-chat")
SERVER_VERSION = "2.0.11"
CHAT_TOOLS = ["chat_capabilities", "chat_join", "chat_status", "chat_poll", "chat_standby",
              "chat_history", "chat_send", "chat_who", "chat_mentions", "chat_reconnect"]


@mcp.tool()
def check_version() -> dict:
    """Discover the PKM Chatroom component version and available chat tools."""
    return {"name": "pkm-chat", "version": SERVER_VERSION, "capability": "pkm-chatroom",
            "chat_tools": CHAT_TOOLS}


@mcp.tool()
def chat_capabilities() -> dict:
    """Discover all PKM Chatroom tools and the Join -> Standby -> Post workflow.

    Use this for live multi-agent chat, Magic Link joining, directed @message
    waiting, posting, status, members, history, or reconnect support.
    """
    return {"ok": True, "capability": "pkm-chatroom", "version": SERVER_VERSION,
            "workflow": ["chat_join", "chat_standby", "chat_send", "chat_standby"],
            "chat_tools": CHAT_TOOLS,
            "instruction": "Join with a pkchat:v1 Magic Link and alias, then keep using chat_standby after each chat_send."}


@mcp.tool()
def chat_join(magic_link: str, name: str) -> dict:
    """PKM Chatroom: join by Magic Link and alias, then wait for Host approval.

    Pass the host's pkchat:v1 Magic Link and requested alias. This call may wait
    up to 125 seconds while the Host chooses New User, Reuse, or Reject.
    """
    alias = str(name or "").strip()
    if not alias:
        return {"ok": False, "error_code": "alias-required", "error": "The Host must assign this agent an alias."}
    try:
        url, secret, room_id = parse_magic_link(magic_link)
    except ValueError as error:
        return {"ok": False, "error_code": "invalid-magic-link", "error": str(error)}
    key = alias.casefold()
    bridge = ChatBridge()
    bridge.configure(url, secret, alias, room_id=room_id)
    bridge.start()
    ok, error = bridge.wait_for_join()
    if not ok:
        return {"ok": False, "error_code": bridge.error_code or "join-failed",
            "error": error or "Join was not approved.", "name": alias}
    previous = bridges.get(key)
    if previous is not None:
        previous._stop = True
    bridges[key] = bridge
    return {"ok": True, **bridge.status(), "active_aliases": _aliases(),
            "instruction": f"Use name={alias!r} on subsequent chat tools."}


@mcp.tool()
def chat_status(name: str = "") -> dict:
    """PKM Chatroom: report connection, Room lifecycle, identity, and standby status.

    state 'idle' means no meeting is configured yet — call chat_join(magic_link, name)."""
    if not str(name or "").strip() and len(bridges) != 1:
        return {"ok": True, "active_aliases": _aliases(),
                "connections": [bridge.status() for bridge in bridges.values()]}
    try:
        return {"ok": True, **_resolve_bridge(name).status(), "active_aliases": _aliases()}
    except ValueError as error:
        return {"ok": False, "error": str(error), "active_aliases": _aliases()}


@mcp.tool()
def chat_poll(max: int = 50, name: str = "") -> dict:
    """Return NEW room messages since the last poll and advance the read cursor.

    Each message is {seq, type: 'chat'|'system', from, text, ts}. Call this
    repeatedly to follow the conversation without re-reading old lines.
    """
    try:
        bridge = _resolve_bridge(name)
        return {"ok": True, "name": bridge.name, "messages": bridge.poll(max), "status": bridge.status()["state"]}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_standby(timeout: int = 300, max_messages: int = 8, max_bytes: int = 32768,
                 batch_wait_ms: int = 250, name: str = "") -> dict:
    """PKM Chatroom: block until @name/@all, control, close, transport, or timeout.

    The connection is already in standby after chat_join. This blocking call
    returns event='message' for any directed message. After chat_send the Agent
    automatically returns to standby. /stop_conversation and /release terminate
    it only after this Agent's conversation has started; leave/Room close always terminate.
    """
    try:
        bridge = _resolve_bridge(name)
        return {"ok": True, **bridge.standby(timeout, max_messages, max_bytes, batch_wait_ms),
            "status": bridge.status()["state"], "name": bridge.name}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_history(limit: int = 50, name: str = "") -> dict:
    """Return the most recent buffered messages WITHOUT advancing the poll cursor."""
    try:
        bridge = _resolve_bridge(name)
        return {"ok": True, "name": bridge.name, "messages": bridge.history(limit)}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_send(text: str, name: str = "", continue_working: bool = False) -> dict:
    """PKM Chatroom: post a directed message.

    Final replies return to standby. Pass continue_working=true for progress or
    acknowledgement posts sent before work is complete, preserving thinking state.

    Prefix with '/' to run a room command (e.g. '/help', '/list_audiences',
    '/whois <name>'); the private reply from 'roombot' arrives via chat_poll.
    """
    try:
        bridge = _resolve_bridge(name)
        bridge.send_state("sending")
        ok, err = bridge.send_text(text)
        bridge.send_state("thinking" if continue_working else "standby")
        return {"ok": ok, "error_code": "" if ok else "transport-error", "error": err,
            "retryable": not ok, "name": bridge.name, "room_id": bridge.room_id,
            "participant_id": bridge.participant_id, **bridge._lifecycle_fields()}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_who(name: str = "") -> dict:
    """List the members currently present in the room."""
    try:
        bridge = _resolve_bridge(name)
        with bridge.lock:
            return {"ok": True, "name": bridge.name, "room_id": bridge.room_id,
                    "participant_id": bridge.participant_id, "members": list(bridge.members)}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_mentions(limit: int = 20, name: str = "") -> dict:
    """Return recent messages that @mention YOU (this agent) or @all/@everyone.

    Does NOT advance the poll cursor. Each item is
    {seq, type, from, text, ts, mentioned, mentions:[names]}. Use this to catch
    up on things specifically addressed to you without re-reading the whole room.
    """
    try:
        bridge = _resolve_bridge(name)
        return {"ok": True, "mentions": bridge.mentions(limit), "name": bridge.name}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


@mcp.tool()
def chat_reconnect(name: str = "") -> dict:
    """Retry the current Magic Link connection after a transient network error.
    If the host refreshed the key, obtain a new Magic Link and call chat_join."""
    try:
        bridge = _resolve_bridge(name)
        return {"ok": True, **bridge.reconnect(), "name": bridge.name}
    except ValueError as error:
        return {"ok": False, "error": str(error)}


if __name__ == "__main__":
    _log("starting idle — call chat_join(magic_link, name) to join a meeting")
    mcp.run()
