"""
PKM Agent-to-Agent session protocol (transport-agnostic).

This module defines a tiny, TCP-inspired *session* layer that runs on top of the
Personal Knowledge chatroom. The chatroom already gives ordered, reliable,
buffered delivery, so this layer does NOT re-implement retransmission. What it
adds is application-level coordination for multi-agent self-refine / debate:

  * handshake ....... role negotiation + readiness barrier  (open / join / start)
  * turn-token ...... a "conch" that makes turn-taking unambiguous (grant)
  * piggybacked ACK . each turn acknowledges the previous one (ack=prev_seq)
  * teardown ........ graceful end / abort                   (end / end_ack / rst)
  * liveness ........ heartbeat for a stalled token-holder    (ping / pong)

Both orchestration modes share ONE machine; they differ only in who computes the
next `grant`:
  * "referee": a Judge always regains the token and grants the next speaker.
  * "p2p"    : `grant` follows whoever a turn is addressed `to`.

Frames are carried inside ordinary chat messages: a frame is JSON prefixed by a
sentinel (WIRE_PREFIX) so humans and non-participants can tell protocol traffic
from chat. `SessionMachine` is pure logic — it consumes parsed frames and returns
(events, outbound_frames); a driver (test harness or chat_agent.py) does the I/O.
"""
from __future__ import annotations

import re
import json
import time
import itertools
from typing import Any, Optional

PROTO_VERSION = 1
# Sentinel marking a protocol frame embedded in a chat message. Uses rare chars
# so it never collides with normal chat text.
WIRE_PREFIX = "\u2b1b\u2b1bPKMX\u2b1b"

FRAME_TYPES = {"open", "join", "start", "turn", "ping", "pong", "end", "end_ack", "rst", "state"}
# Message kinds for `turn` frames (FIPA-ACL-inspired performatives).
#   control/candidate/critique/score/observation/intro/info/verdict — debate flow
#   command/ack/result/standby/error — the standby -> command -> ack -> work ->
#     result(+standby) agent runtime lifecycle.
TURN_KINDS = {"control", "candidate", "critique", "score", "observation", "intro",
              "info", "verdict", "command", "ack", "result", "standby", "error"}


# ── wire encode / decode ────────────────────────────────────────────────────
def encode(frame: dict) -> str:
    """Serialize a frame to the string carried in a chat message."""
    return WIRE_PREFIX + json.dumps(frame, separators=(",", ":"), ensure_ascii=False)


def decode(text: str) -> Optional[dict]:
    """Parse a chat message back into a frame, or None if it isn't protocol traffic."""
    if not isinstance(text, str) or not text.startswith(WIRE_PREFIX):
        return None
    try:
        f = json.loads(text[len(WIRE_PREFIX):])
    except Exception:
        return None
    if isinstance(f, dict) and f.get("t") in FRAME_TYPES:
        return f
    return None


def is_protocol(text: str) -> bool:
    return isinstance(text, str) and text.startswith(WIRE_PREFIX)


# ── @mention parsing (also used by the notify/UI layer) ─────────────────────
# Matches @name or @"name with spaces"; name chars kept conservative.
_MENTION_RE = re.compile(r'(?<![\w@])@(?:"([^"]{1,60})"|([A-Za-z0-9_][\w\-]{0,59}))')


def parse_mentions(text: str) -> list[str]:
    """Return the list of names @mentioned in a chat message (order-preserving, de-duped)."""
    if not text:
        return []
    out: list[str] = []
    for m in _MENTION_RE.finditer(text):
        name = m.group(1) or m.group(2)
        if name and name not in out:
            out.append(name)
    return out


def mentions_name(text: str, name: str) -> bool:
    """True if `name` is @mentioned in text (case-insensitive). '@all'/'@everyone' match anyone."""
    if not text or not name:
        return False
    low = {m.lower() for m in parse_mentions(text)}
    return name.lower() in low or "all" in low or "everyone" in low


# ── session state machine ───────────────────────────────────────────────────
class SessionMachine:
    """One agent's view of a session. Pure logic: feed it inbound frames, get
    back (events, outbound_frames). The owning agent's "brain" (scripted or LLM)
    reacts to events and asks the machine to build turn/end frames."""

    LISTEN = "LISTEN"
    OPENING = "OPENING"
    ESTABLISHED = "ESTABLISHED"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"

    # Agent runtime sub-states (meaningful once ESTABLISHED).
    STANDBY = "STANDBY"   # in the room, idle, awaiting a command / its turn
    WORKING = "WORKING"   # holds the conch, executing a task

    def __init__(self, me: str, role: Optional[str] = None):
        self.me = me
        self.role = role                 # this agent's role (may be set from `open`)
        self.sid: Optional[str] = None
        self.state = self.LISTEN
        self.agent_state: Optional[str] = None   # STANDBY | WORKING once established
        self.mode: Optional[str] = None  # 'referee' | 'p2p'
        self.roles_needed: list[str] = []
        self.roster: dict[str, dict] = {}   # name -> {role, ready}
        self.role_of: dict[str, str] = {}   # role -> name
        self.initiator: Optional[str] = None
        self.token: Optional[str] = None    # name currently holding the conch
        self.max_rounds: Optional[int] = None
        self.round = 0
        self.topic = ""
        self.last: dict | None = None       # last turn we observed {from,kind,payload,round}
        self._seq = itertools.count(1)
        self._first_speaker: Optional[str] = None

    # -- helpers --------------------------------------------------------------
    def holds_token(self) -> bool:
        return self.state == self.ESTABLISHED and self.token == self.me

    def _base(self, t: str, **kw) -> dict:
        fr = {"v": PROTO_VERSION, "t": t, "sid": self.sid, "from": self.me,
              "ts": int(time.time() * 1000)}
        fr.update({k: v for k, v in kw.items() if v is not None})
        return fr

    def _all_ready(self) -> bool:
        return all(r in self.role_of for r in self.roles_needed)

    # -- outbound builders ----------------------------------------------------
    def open(self, topic: str, roles: list[str], mode: str = "referee",
             max_rounds: int = 8, first_speaker: Optional[str] = None,
             sid: Optional[str] = None) -> list[dict]:
        """Initiator opens a session. If this agent also fills a role, it's
        recorded immediately (self-join)."""
        self.sid = sid or f"m-{int(time.time())}-{self.me}"
        self.topic = topic
        self.mode = mode
        self.roles_needed = list(roles)
        self.max_rounds = max_rounds
        self.initiator = self.me
        self._first_speaker = first_speaker
        self.state = self.OPENING
        if self.role and self.role in roles:
            self.roster[self.me] = {"role": self.role, "ready": True}
            self.role_of[self.role] = self.me
        return [self._base("open", meta={
            "topic": topic, "roles": list(roles), "mode": mode,
            "max_rounds": max_rounds, "first_speaker": first_speaker,
        })]

    def turn(self, kind: str, payload: str, to: str = "all",
             grant: Optional[str] = None, meta: Optional[dict] = None) -> dict:
        """Build a turn frame. Only valid while holding the token."""
        if not self.holds_token():
            raise RuntimeError(f"{self.me} tried to speak without the token (holder={self.token})")
        seq = next(self._seq)
        ack = self.last.get("seq") if self.last else None
        m = dict(meta or {})
        m.setdefault("round", self.round)
        fr = self._base("turn", to=to, kind=kind, payload=payload, seq=seq, ack=ack,
                        grant=grant, meta=m)
        # Sending the turn passes the conch to `grant` (or nobody).
        self.token = grant
        return fr

    def end(self, reason: str = "done", verdict: Optional[str] = None) -> dict:
        self.state = self.CLOSING
        return self._base("end", meta={"reason": reason, "verdict": verdict})

    # -- agent runtime lifecycle helpers --------------------------------------
    def ack(self, to: str, note: str = "") -> dict:
        """Acknowledge a command and enter WORKING while RETAINING the conch
        (grant=self) so no one else speaks until we report back."""
        fr = self.turn("ack", note or "acknowledged; working", to=to, grant=self.me)
        self.agent_state = self.WORKING
        return fr

    def result(self, payload: str, to: str, standby: bool = True,
               verdict: Optional[str] = None) -> dict:
        """Report task results and hand the conch back. `standby=True` is the
        agent's ack that it has returned to STANDBY and awaits the next command."""
        meta = {"standby": standby}
        if verdict is not None:
            meta["verdict"] = verdict
        fr = self.turn("result", payload, to=to, grant=to, meta=meta)
        self.agent_state = self.STANDBY
        return fr

    def ping(self, to: str) -> dict:
        return self._base("ping", to=to)

    # -- inbound handling -----------------------------------------------------
    def on_frame(self, fr: dict) -> tuple[list[tuple[str, dict]], list[dict]]:
        """Process one inbound frame. Returns (events, outbound_frames).
        Events: ('established',{}), ('granted',{...}), ('observed',{...}),
                ('ended',{reason,verdict}), ('joined',{name,role})."""
        if not isinstance(fr, dict):
            return [], []
        t = fr.get("t")
        frm = fr.get("from")
        if frm == self.me and t not in ("open",):
            return [], []  # ignore our own echoes
        # Session isolation: reject stale/foreign sessions so replayed or
        # overlapping traffic can't hijack us.
        if t == "open":
            if self.state != self.LISTEN:
                return [], []  # already in a session; ignore other opens
        elif self.sid is not None and fr.get("sid") not in (None, self.sid):
            return [], []
        handler = getattr(self, f"_on_{t}", None)
        if handler is None:
            return [], []
        return handler(fr)

    def _on_open(self, fr: dict):
        if self.initiator == self.me:
            return [], []
        meta = fr.get("meta", {})
        self.sid = fr.get("sid")
        self.topic = meta.get("topic", "")
        self.mode = meta.get("mode")
        self.roles_needed = list(meta.get("roles", []))
        self.max_rounds = meta.get("max_rounds")
        self.initiator = fr.get("from")
        self._first_speaker = meta.get("first_speaker")
        self.state = self.OPENING
        # Claim our role if we have one that the session needs.
        if self.role and self.role in self.roles_needed:
            return [], [self._base("join", meta={"role": self.role, "ready": True, "standby": True})]
        return [], []

    def _record_member(self, name: str, role: str):
        self.roster[name] = {"role": role, "ready": True}
        if role:
            self.role_of[role] = name

    def _on_join(self, fr: dict):
        meta = fr.get("meta", {})
        name, role = fr.get("from"), meta.get("role")
        self._record_member(name, role)
        events = [("joined", {"name": name, "role": role})]
        out: list[dict] = []
        # Only the initiator drives the readiness barrier -> start.
        if self.initiator == self.me and self.state == self.OPENING and self._all_ready():
            first = self._first_speaker or self.role_of.get(self.roles_needed[0])
            self.state = self.ESTABLISHED
            self.agent_state = self.STANDBY
            self.token = first
            out.append(self._base("start", meta={"first_speaker": first,
                                                 "roster": {n: v["role"] for n, v in self.roster.items()}}))
            events.append(("established", {"first": first}))
            if first == self.me:
                events.append(("granted", {"from": None, "kind": "start", "payload": "", "round": self.round}))
        return events, out

    def _on_start(self, fr: dict):
        meta = fr.get("meta", {})
        for name, role in (meta.get("roster") or {}).items():
            self._record_member(name, role)
        self.state = self.ESTABLISHED
        self.agent_state = self.STANDBY
        self.token = meta.get("first_speaker")
        events = [("established", {"first": self.token})]
        if self.token == self.me:
            events.append(("granted", {"from": None, "kind": "start", "payload": "", "round": self.round}))
        return events, []

    def _on_turn(self, fr: dict):
        # Enforce that the sender actually held the conch.
        if fr.get("from") != self.token:
            return [], []  # out-of-turn frame: ignore (defensive)
        meta = fr.get("meta", {})
        self.round = meta.get("round", self.round)
        info = {"from": fr.get("from"), "kind": fr.get("kind"),
                "payload": fr.get("payload", ""), "round": self.round, "seq": fr.get("seq"),
                "to": fr.get("to"), "meta": meta}
        self.last = info
        self.token = fr.get("grant")  # conch moves to whoever was granted
        if self.token == self.me:
            return [("granted", info)], []
        return [("observed", info)], []

    def _on_ping(self, fr: dict):
        if fr.get("to") in (self.me, "all", None):
            return [], [self._base("pong", to=fr.get("from"))]
        return [], []

    def _on_pong(self, fr: dict):
        return [("pong", {"from": fr.get("from")})], []

    def _on_end(self, fr: dict):
        meta = fr.get("meta", {})
        out = []
        if self.state != self.CLOSED:
            out.append(self._base("end_ack", meta={}))
        self.state = self.CLOSED
        return [("ended", {"reason": meta.get("reason"), "verdict": meta.get("verdict")})], out

    def _on_end_ack(self, fr: dict):
        self.state = self.CLOSED
        return [("closed", {})], []

    def _on_rst(self, fr: dict):
        self.state = self.CLOSED
        return [("ended", {"reason": "rst", "verdict": None})], []
