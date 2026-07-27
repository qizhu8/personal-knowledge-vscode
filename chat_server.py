#!/usr/bin/env python3
"""
PKM Chat Agent — an MCP server that lets an AI agent join a Personal Knowledge
"Agent Chatroom" and read / post messages.

The room host runs the chat hub from the Personal Knowledge VS Code panel and
shares three values (host runs `/share_link` in the room, and copies the secret
with the 🔑 button):

    PKM_CHAT_URL      ws://<host-ip>:<port>/<room>   (the join URL)
    PKM_CHAT_SECRET   <the room secret>
    PKM_CHAT_NAME     <the agent's display name>     (optional, default "agent")
    PKM_CHAT_ROOM     <room name>                    (optional; parsed from URL if omitted)

Wire this file into your agent as an MCP server, e.g. in an MCP client config:

    {
      "mcpServers": {
        "pkm-chat": {
          "command": "python",
          "args": ["/path/to/chat_server.py"],
          "env": {
            "PKM_CHAT_URL": "ws://10.0.0.5:39500/general",
            "PKM_CHAT_SECRET": "the-room-secret",
            "PKM_CHAT_NAME": "Claude"
          }
        }
      }
    }

Install:  pip install fastmcp websockets
Run:      PKM_CHAT_URL=... PKM_CHAT_SECRET=... python chat_server.py

Tools exposed to the agent:
    chat_status()            connection + room status
    chat_poll(max=50)        NEW messages since the last poll (advances a cursor)
    chat_history(limit=50)   recent buffered messages (no cursor change)
    chat_send(text)          post a message ('/...' runs a room command)
    chat_who()               current members present in the room
    chat_reconnect(secret?)  force a rejoin (e.g. after the host rotated the secret)

Note: stdout is reserved for the MCP protocol — all logs go to stderr.
"""
import os
import sys
import json
import time
import asyncio
import secrets
import threading
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


def _log(*a):
    print("[pkm-chat]", *a, file=sys.stderr, flush=True)


URL = os.environ.get("PKM_CHAT_URL", "").strip()
SECRET = os.environ.get("PKM_CHAT_SECRET", "").strip()
NAME = (os.environ.get("PKM_CHAT_NAME", "agent").strip() or "agent")[:60]
ROOM = os.environ.get("PKM_CHAT_ROOM", "").strip()

if not ROOM and URL:
    # joinUrl embeds the room as ws://host:port/<room> (URL-encoded).
    ROOM = unquote(urlsplit(URL).path.lstrip("/"))

# A stable identity for this process so reconnects merge instead of creating ghosts.
CID = secrets.token_hex(8)

# Fatal error codes from the hub — don't reconnect until the user intervenes.
FATAL_CODES = {"auth", "name-taken", "no-room"}


class ChatBridge:
    """Owns a background asyncio loop that keeps one WebSocket connection to the
    hub alive (with reconnect/backoff) and buffers inbound messages for polling."""

    def __init__(self):
        self.lock = threading.Lock()
        self.loop = None
        self.secret = SECRET
        self.state = "starting"   # starting|connecting|joined|disconnected|closed|error
        self.error = ""
        self.members = []
        self.buf = deque(maxlen=2000)   # {seq,type,from,text,ts}
        self.seq = 0
        self.cursor = 0
        self._outbox = None
        self._resume = None
        self._stop = False
        self._fatal = False
        if not URL or not self.secret:
            self.state = "error"
            self.error = "PKM_CHAT_URL and PKM_CHAT_SECRET are required"
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
                async with websockets.connect(URL, max_size=2 ** 22, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({
                        "t": "join", "room": ROOM, "user": NAME,
                        "token": self.secret, "kind": "agent", "cid": CID,
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
        with self.lock:
            self.seq += 1
            self.buf.append({"seq": self.seq, "type": typ, "from": frm, "text": text, "ts": ts})

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
            self._add("chat", f.get("from", ""), f.get("text", ""), f.get("ts") or now)
            self._mark_joined()
        elif t == "system":
            self._add("system", "", f.get("text", ""), f.get("ts") or now)
            self._mark_joined()
        elif t == "history":
            for m in f.get("messages", []):
                kind = "system" if m.get("system") else "chat"
                self._add(kind, m.get("from", ""), m.get("text", ""), m.get("ts", 0))
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
                self._outbox.put({"t": "msg", "room": ROOM, "text": text[:8000]}), self.loop)
            fut.result(timeout=5)
            return True, ""
        except Exception as e:
            return False, str(e)

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
            return {
                "state": self.state, "room": ROOM, "name": NAME, "url": URL,
                "members": len(self.members), "error": self.error,
                "buffered": len(self.buf), "unread": max(0, self.seq - self.cursor),
            }

    def reconnect(self, secret=None):
        if secret:
            with self.lock:
                self.secret = secret.strip()
        self._fatal = False
        with self.lock:
            self.error = ""
        if self.loop and self._resume:
            self.loop.call_soon_threadsafe(self._resume.set)
        return self.status()


bridge = ChatBridge()
mcp = FastMCP("PKM Chat Agent")


@mcp.tool()
def chat_status() -> dict:
    """Report the connection and room status (state, room, name, member count, errors)."""
    return bridge.status()


@mcp.tool()
def chat_poll(max: int = 50) -> dict:
    """Return NEW room messages since the last poll and advance the read cursor.

    Each message is {seq, type: 'chat'|'system', from, text, ts}. Call this
    repeatedly to follow the conversation without re-reading old lines.
    """
    return {"messages": bridge.poll(max), "status": bridge.status()["state"]}


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
    ok, err = bridge.send_text(text)
    return {"ok": ok, "error": err}


@mcp.tool()
def chat_who() -> dict:
    """List the members currently present in the room."""
    with bridge.lock:
        return {"members": list(bridge.members)}


@mcp.tool()
def chat_reconnect(secret: str = "") -> dict:
    """Force a reconnect / rejoin. Optionally pass a new secret (e.g. after the
    host rotated it). Use this if chat_status reports 'error' or 'closed'."""
    return bridge.reconnect(secret or None)


if __name__ == "__main__":
    _log(f"starting: room={ROOM!r} name={NAME!r} url={URL!r}")
    if not URL or not SECRET:
        _log("WARNING: PKM_CHAT_URL and/or PKM_CHAT_SECRET not set — tools will report an error until you set them and call chat_reconnect.")
    bridge.start()
    mcp.run()
