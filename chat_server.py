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
    3. Call chat_standby immediately. When /start_conversation names you, keep
       calling chat_standby after every reply or timeout until roombot announces
       /stop_conversation or you are /release'd. Do not end the agent turn early.

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
    from protocol import parse_mentions, mentions_name
except Exception:
    def parse_mentions(_text):
        return []

    def mentions_name(_text, _name):
        return False


def _log(*a):
    print("[pkm-chat]", *a, file=sys.stderr, flush=True)


# A stable identity for this process so reconnects merge instead of creating ghosts.
CID = secrets.token_hex(8)

# Fatal error codes from the hub — don't reconnect until the user intervenes.
FATAL_CODES = {"auth", "name-taken", "no-room"}


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
    parsed = urlsplit(url)
    if decoded.get("v") != 1 or parsed.scheme not in ("ws", "wss") or not parsed.netloc or not parsed.path.strip("/") or not secret:
        raise ValueError("Chat Magic Link is missing valid room credentials.")
    return url, secret


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
        self.state = "idle"   # idle|connecting|joined|disconnected|closed|error
        self.error = "no meeting configured — call chat_join(magic_link, name)"
        self.members = []
        self.buf = deque(maxlen=2000)   # {seq,type,from,text,ts}
        self.seq = 0
        self.cursor = 0
        self.standby_cursor = 0
        self.conversation_active = False
        self.runtime_state = "idle"
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
                    await ws.send(json.dumps({
                        "t": "join", "room": self.room, "user": self.name,
                        "token": self.secret, "kind": "agent", "cid": CID,
                    }))
                    await ws.send(json.dumps({"t": "agent.state", "room": self.room,
                                              "state": self.runtime_state}))
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
            except Exception as e:
                with self.lock:
                    self.state = "disconnected"
                    self.error = str(e)
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
    def _add(self, typ, frm, text, ts):
        if text == "" and typ == "chat":
            return
        # Flag @mentions of *this* agent (ignore our own messages).
        mentions, mentioned = [], False
        if typ == "chat" and frm != self.name:
            try:
                mentions = parse_mentions(text)
                mentioned = mentions_name(text, self.name)
            except Exception:
                pass
        with self.changed:
            self.seq += 1
            self.buf.append({"seq": self.seq, "type": typ, "from": frm, "text": text,
                             "ts": ts, "mentioned": mentioned, "mentions": mentions})
            self.changed.notify_all()

    def _mark_joined(self):
        with self.lock:
            if self.state not in ("closed", "error"):
                self.state = "joined"

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
            self._add("chat", f.get("from", ""), f.get("text", ""), f.get("ts") or now)
            self._mark_joined()
        elif t == "system":
            self._add("system", "", f.get("text", ""), f.get("ts") or now)
            self._mark_joined()
        elif t == "history":
            for m in f.get("messages", []):
                kind = "system" if m.get("system") else "chat"
                self._add(kind, m.get("from", ""), m.get("text", ""), m.get("ts", 0))
            with self.lock:
                self.cursor = self.seq
                self.standby_cursor = self.seq
            self._mark_joined()
        elif t == "presence":
            with self.lock:
                self.members = f.get("members", [])
            self._mark_joined()
        elif t == "rekey":
            with self.lock:
                self.secret = f.get("secret", self.secret)
            _log("host rotated the room secret; adopted the new one")
        elif t == "error":
            code, msg = f.get("code", ""), f.get("msg", "")
            with self.lock:
                self.error = f"{code}: {msg}"
            _log("hub error:", self.error)
            if code in FATAL_CODES:
                self._fatal = True
                with self.lock:
                    self.state = "error"
        elif t in ("closed", "kicked"):
            reason = f.get("reason", "")
            with self.lock:
                self.state = "closed"
                self.error = (("kicked: " if t == "kicked" else "") + reason).strip()
            self._fatal = True

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
                "buffered": len(self.buf), "unread": max(0, self.seq - self.cursor),
                "unread_mentions": unread_mentions,
            }

    def mentions(self, limit):
        with self.lock:
            hits = [m for m in self.buf if m.get("mentioned")]
            return hits[-limit:] if limit else hits

    def standby(self, timeout=300):
        """Block until this agent is addressed during a coordinated conversation."""
        self.send_state("standby")
        deadline = time.monotonic() + max(1, min(int(timeout or 300), 1800))
        with self.changed:
            while True:
                pending = [m for m in self.buf if m["seq"] > self.standby_cursor]
                for message in pending:
                    text = str(message.get("text") or "").strip()
                    low = text.lower()
                    names = [str(name).lower() for name in (message.get("mentions") or [])]
                    prepared = message.get("from") == "roombot" and "conversation prepared" in low
                    started = message.get("from") == "roombot" and "conversation started" in low
                    joined = message.get("from") == "roombot" and "joined the conversation" in low
                    if (prepared or started or joined) and (self.name.lower() in names or "all" in names or "everyone" in names):
                        self.conversation_active = True
                        self.send_state("standby")
                        self.standby_cursor = message["seq"]
                        continue
                    if low.startswith("/stop_conversation") or "conversation stopped" in low:
                        self.conversation_active = False
                        self.send_state("idle")
                        self.standby_cursor = message["seq"]
                        return {"event": "stopped", "messages": pending, "instruction": "Conversation ended. Return control to the user."}
                    if low.startswith("/release") and self.name.lower() in names:
                        self.conversation_active = False
                        self.send_state("idle")
                        self.standby_cursor = message["seq"]
                        return {"event": "released", "messages": pending, "instruction": "You were released. Return control to the user."}
                    if not self.conversation_active or message.get("from") == self.name:
                        self.standby_cursor = message["seq"]
                        continue
                    directed = self.name.lower() in names or "all" in names or "everyone" in names
                    granted = message.get("from") == "roombot" and directed and "your turn" in low
                    direct_message = message.get("from") != "roombot" and directed
                    if granted or direct_message:
                        self.standby_cursor = message["seq"]
                        self.send_state("thinking")
                        return {
                            "event": "message", "messages": pending,
                            "instruction": "Respond with chat_send, then IMMEDIATELY call chat_standby again. Do not finish your turn while the conversation is active.",
                        }
                    self.standby_cursor = message["seq"]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {
                        "event": "timeout", "messages": [],
                        "instruction": "No turn was granted yet. IMMEDIATELY call chat_standby again; do not finish while the conversation is active.",
                    }
                self.changed.wait(timeout=remaining)

    def configure(self, url, secret, name=None, room=None):
        """Point the bridge at a room and (re)connect. Returns the new status."""
        url = (url or "").strip()
        secret = (secret or "").strip()
        if not url or not secret:
            return {"ok": False, "error": "url and secret are required", **self.status()}
        with self.lock:
            self.url = url
            self.secret = secret
            if name:
                self.name = name.strip()[:60] or self.name
            self.room = (room or "").strip() or unquote(urlsplit(url).path.lstrip("/"))
            self.error = ""
            self.cursor = self.seq  # don't replay old room's buffer as "new"
            self.standby_cursor = self.seq
            self.conversation_active = False
            self.runtime_state = "idle"
        self._fatal = False
        if self.loop and self._resume:
            self.loop.call_soon_threadsafe(self._resume.set)
        return {"ok": True, **self.status()}

    def reconnect(self):
        self._fatal = False
        with self.lock:
            self.error = ""
        if self.loop and self._resume:
            self.loop.call_soon_threadsafe(self._resume.set)
        return self.status()


bridge = ChatBridge()
mcp = FastMCP("pkm-chat")
SERVER_VERSION = "2.0.0"


@mcp.tool()
def check_version() -> dict:
    """Return this pkm-chat MCP server's schema version."""
    return {"name": "pkm-chat", "version": SERVER_VERSION}


@mcp.tool()
def chat_join(magic_link: str, name: str) -> dict:
        """Join a Personal Knowledge Agent Chatroom NOW and start participating.

        Pass the host's pkchat:v1 Magic Link and your assigned name. The Magic Link
        contains the room URL and key, so do not ask for them separately.
    """
        try:
            url, secret = parse_magic_link(magic_link)
        except ValueError as error:
            return {"ok": False, "error": str(error), **bridge.status()}
        return bridge.configure(url, secret, name)


@mcp.tool()
def chat_status() -> dict:
    """Report the connection and room status (state, room, name, member count, errors).

    state 'idle' means no meeting is configured yet — call chat_join(magic_link, name)."""
    return bridge.status()


@mcp.tool()
def chat_poll(max: int = 50) -> dict:
    """Return NEW room messages since the last poll and advance the read cursor.

    Each message is {seq, type: 'chat'|'system', from, text, ts}. Call this
    repeatedly to follow the conversation without re-reading old lines.
    """
    return {"messages": bridge.poll(max), "status": bridge.status()["state"]}


@mcp.tool()
def chat_standby(timeout: int = 300) -> dict:
    """Continuously watch the room during a coordinated conversation.

    Call immediately after joining. When /start_conversation includes you, you
    MUST remain focused on Chatroom. On event='message', respond with chat_send
    and IMMEDIATELY call chat_standby again. On event='timeout', call it again
    without ending the agent turn. Only stop on event='stopped' after
    /stop_conversation or event='released' after /release.
    """
    return {**bridge.standby(timeout), "status": bridge.status()["state"], "name": bridge.name}


@mcp.tool()
def chat_history(limit: int = 50) -> dict:
    """Return the most recent buffered messages WITHOUT advancing the poll cursor."""
    return {"messages": bridge.history(limit)}


@mcp.tool()
def chat_send(text: str) -> dict:
    """Post a message to the room.

    Prefix with '/' to run a room command (e.g. '/help', '/list_audiences',
    '/whois <name>'); the private reply from 'roombot' arrives via chat_poll.
    """
    bridge.send_state("sending")
    ok, err = bridge.send_text(text)
    bridge.send_state("standby" if bridge.conversation_active else "idle")
    return {"ok": ok, "error": err}


@mcp.tool()
def chat_who() -> dict:
    """List the members currently present in the room."""
    with bridge.lock:
        return {"members": list(bridge.members)}


@mcp.tool()
def chat_mentions(limit: int = 20) -> dict:
    """Return recent messages that @mention YOU (this agent) or @all/@everyone.

    Does NOT advance the poll cursor. Each item is
    {seq, type, from, text, ts, mentioned, mentions:[names]}. Use this to catch
    up on things specifically addressed to you without re-reading the whole room.
    """
    return {"mentions": bridge.mentions(limit), "name": bridge.name}


@mcp.tool()
def chat_reconnect() -> dict:
    """Retry the current Magic Link connection after a transient network error.
    If the host refreshed the key, obtain a new Magic Link and call chat_join."""
    return bridge.reconnect()


if __name__ == "__main__":
    _log("starting idle — call chat_join(magic_link, name) to join a meeting")
    bridge.start()
    mcp.run()
