#!/usr/bin/env python3
"""
PKM live session agent — runs the protocol.SessionMachine over a real chatroom.

This is the LIVE counterpart to sim_protocol.py: instead of an in-process bus, it
connects to the hub via WebSocket, joins a room as an agent, and drives the
standby -> command -> ack -> work -> result(+standby) lifecycle against the real
relay. No LLM yet — the "brain" is scripted, so we can validate the wiring end to
end before plugging a model in.

Frames travel inside ordinary chat messages (protocol.encode adds a sentinel
prefix so humans/non-participants can tell them apart). For a legible demo the
agent also posts short plain-text "narration" lines for the key beats.

Examples (run in two terminals, same room/secret):

    export PKM_CHAT_URL='ws://10.224.120.214:54482/aether%20chatroom'
    export PKM_CHAT_SECRET='...'

    # the worker: joins and stands by, awaiting commands
    python chat_agent.py --role Worker --name Wanda

    # the commander: opens the session and issues a queue of commands
    python chat_agent.py --role Commander --name Boss --initiate \
        --tasks "analyze log A" "summarize folder B"

Install: pip install websockets
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
import asyncio
import secrets
import argparse
from urllib.parse import urlsplit, unquote

try:
    import websockets
except ImportError:
    raise SystemExit("websockets not found. Run: pip install websockets")

import protocol as P
from llm import AiClient


WORKER_SYSTEM = (
    "You are a Worker agent in a multi-agent chatroom. You receive one task at a "
    "time and must complete it concisely. Reply with ONLY the result of the task "
    "(no preamble, no sign-off). Keep it under ~120 words."
)


def log(*a):
    print("[agent]", *a, file=sys.stderr, flush=True)


class LiveAgent:
    def __init__(self, url, secret, name, room, role, mode="referee",
                 initiate=False, tasks=None, roles=None, topic="task queue",
                 narrate=True, open_delay=2.0, idle_timeout=90.0, llm=None,
                 converse=False, system_prompt="", poll_interval=3.0, end_idle=600.0):
        self.url = url
        self.secret = secret
        self.name = name
        self.room = room
        self.role = role
        self.mode = mode
        self.initiate = initiate
        self.tasks = list(tasks or [])
        self.roles = roles or ["Commander", "Worker"]
        self.topic = topic
        self.narrate = narrate
        self.open_delay = open_delay
        self.idle_timeout = idle_timeout
        self.llm = llm
        self.converse = converse
        self.system_prompt = system_prompt or (
            "You are an agent in a group chat. Reply concisely and stay on task.")
        self.poll_interval = poll_interval
        self.end_idle = end_idle
        self.conv_active = converse
        self.history = []
        self.pending = []
        self.m = P.SessionMachine(name, role=role)
        self.cid = secrets.token_hex(8)
        self.ws = None
        self.members = []
        self._busy = False
        self._last_activity = time.time()

    # ── wire I/O ─────────────────────────────────────────────────────────────
    async def _send_msg(self, text: str):
        await self.ws.send(json.dumps({"t": "msg", "room": self.room, "text": text}))

    async def _emit(self, items):
        """Send a list of protocol frames (dicts) and/or narration lines (str)."""
        for it in items or []:
            if isinstance(it, str):
                if self.narrate:
                    await self._send_msg(it)
            else:
                await self._send_msg(P.encode(it))
                self._log_frame("OUT", it)
        if items:
            self._last_activity = time.time()

    def _log_frame(self, direction, fr):
        t = fr.get("t")
        if t == "turn":
            log(f"{direction} turn {fr.get('kind')} {fr.get('from')}->{fr.get('to')} "
                f"grant={fr.get('grant')} :: {fr.get('payload','')}")
        else:
            log(f"{direction} {t} {fr.get('from','')} {fr.get('meta','')}")

    # ── main loop ────────────────────────────────────────────────────────────
    async def run(self):
        async with websockets.connect(self.url, max_size=2 ** 22,
                                       ping_interval=20, ping_timeout=20) as ws:
            self.ws = ws
            await ws.send(json.dumps({
                "t": "join", "room": self.room, "user": self.name,
                "token": self.secret, "kind": "agent", "cid": self.cid,
            }))
            log(f"joined room {self.room!r} as {self.name!r} (role={self.role})")
            if self.converse:
                asyncio.ensure_future(self._converse_loop())
            elif self.initiate:
                asyncio.ensure_future(self._open_when_ready())
            if not self.converse:
                asyncio.ensure_future(self._idle_watch())
            try:
                async for raw in ws:
                    await self._on_raw(raw)
                    if self.m.state == P.SessionMachine.CLOSED:
                        break
            finally:
                log(f"exiting (state={self.m.state}, agent_state={self.m.agent_state})")

    async def _open_when_ready(self):
        # Give peers a moment to connect so they receive the `open` live.
        await asyncio.sleep(self.open_delay)
        if self.m.state != P.SessionMachine.LISTEN:
            return
        await self._emit([f"🚀 {self.name} opening session '{self.topic}' "
                          f"(roles: {', '.join(self.roles)})"])
        await self._emit(self.m.open(topic=self.topic, roles=self.roles,
                                     mode=self.mode, first_speaker=self.name))

    async def _idle_watch(self):
        # Safety net: if nothing happens for a while, abort cleanly.
        while self.m.state != P.SessionMachine.CLOSED:
            await asyncio.sleep(5)
            if time.time() - self._last_activity > self.idle_timeout:
                log("idle timeout — closing")
                try:
                    await self._send_msg(P.encode(self.m.end(reason="idle timeout")))
                except Exception:
                    pass
                self.m.state = P.SessionMachine.CLOSED
                return

    # ── directed standby mode ────────────────────────────────────────────────
    def _state_frame(self, st, turn=None):
        meta = {"state": st}
        if turn:
            meta["turn"] = turn
        return {"v": P.PROTO_VERSION, "t": "state", "from": self.name, "meta": meta}

    async def _converse_intake(self, frm, text):
        if P.decode(text):
            return  # ignore raw protocol frames
        if frm == self.name:
            return
        names = [m.lower() for m in P.parse_mentions(text)]
        if self.name.lower() in names or "all" in names or "everyone" in names:
            self.history.append({"from": frm, "text": text})
            self.pending.append({"from": frm, "text": text})

    def _should_respond(self, batch):
        # Respond only to @me/@all; never race other agents on unrelated text.
        for m in batch:
            names = [x.lower() for x in P.parse_mentions(m["text"])]
            directed = self.name.lower() in names or "all" in names or "everyone" in names
            if directed:
                return True
        return False

    def _build_prompt(self):
        lines = [("You" if h["from"] == self.name else h["from"]) + ": " + h["text"]
                 for h in self.history[-24:]]
        return "\n".join(lines) + f"\n\nRespond as {self.name}. Keep it concise."

    async def _converse_loop(self):
        last = time.time()
        while True:
            await asyncio.sleep(self.poll_interval)
            if not self.conv_active:
                last = time.time()
                continue
            if not self.pending:
                if time.time() - last > self.end_idle:
                    await self._disengage("idle timeout")
                continue
            batch, self.pending = self.pending, []
            last = time.time()
            if not self._should_respond(batch):
                continue
            await self._emit([self._state_frame("working")])
            try:
                reply = (await asyncio.to_thread(self.llm.complete, self.system_prompt,
                                                 self._build_prompt())) if self.llm else "(no LLM configured)"
                reply = (reply or "").strip() or "(empty response)"
            except Exception as e:
                reply = f"(LLM error: {e})"
            self.history.append({"from": self.name, "text": reply})
            next_turn = batch[-1]["from"]  # hand the turn back to whoever we answered
            await self._emit([reply, self._state_frame("standby", turn=next_turn)])

    async def _on_raw(self, raw):
        try:
            f = json.loads(raw)
        except Exception:
            return
        t = f.get("t")
        if t == "msg":
            receipt = f.get("receipt") or {}
            if receipt.get("ack") and f.get("id") and self.ws is not None:
                await self.ws.send(json.dumps({"t": "msg.read", "room": self.room, "messageId": f["id"]}))
            if self.converse:
                await self._converse_intake(f.get("from", ""), f.get("text", ""))
            else:
                await self._handle_text(f.get("text", ""))
        elif t == "history":
            # History is replayed on join and may contain protocol frames from
            # PAST sessions. The session is a live negotiation — never let stale
            # replayed frames drive the machine. (Human chat history is ignored
            # by the machine anyway.)
            pass
        elif t == "presence":
            self.members = f.get("members", [])
        elif t == "error":
            log("hub error:", f.get("code"), f.get("msg"))
        elif t in ("closed", "kicked", "stopped"):
            self.m.state = P.SessionMachine.CLOSED

    async def _handle_text(self, text):
        fr = P.decode(text)
        if not fr:
            return  # ordinary human chat / narration — ignore
        self._log_frame("IN", fr)
        self._last_activity = time.time()
        events, out = self.m.on_frame(fr)
        await self._emit(out)
        for ev, data in events:
            await self._emit(self.brain(ev, data))
        # Runtime work phase: once WORKING (after ack), do the task then report.
        if self.m.agent_state == P.SessionMachine.WORKING and not self._busy:
            self._busy = True
            await self._emit(await self._do_work())
            self._busy = False

    # ── scripted brains ──────────────────────────────────────────────────────
    def brain(self, ev, data):
        if self.role == "Commander":
            return self._commander(ev, data)
        if self.role == "Worker":
            return self._worker(ev, data)
        return []

    def _commander(self, ev, data):
        m = self.m
        if ev == "established":
            return [f"🟢 {self.name} ready — session established."]
        if ev != "granted":
            return []
        kind = data.get("kind")
        if kind in ("start", "result"):
            worker = m.role_of.get("Worker")
            if not worker:
                return []
            if self.tasks:
                task = self.tasks.pop(0)
                return [f"📤 {self.name} → {worker}: command '{task}'",
                        m.turn("command", task, to=worker, grant=worker)]
            return [f"🏁 {self.name}: all tasks done — closing.",
                    m.end(reason="all tasks done", verdict=worker)]
        return []

    def _worker(self, ev, data):
        m = self.m
        if ev == "established":
            back = f" (LLM: {self.llm.describe()})" if self.llm else " (scripted)"
            return [f"🟢 {self.name} standing by — awaiting commands.{back}"]
        if ev == "granted" and data.get("kind") == "command":
            self.pending = data.get("payload")
            return [f"✅ {self.name}: ack '{self.pending}', working…",
                    m.ack(to=data.get("from"))]
        if ev == "ended":
            return [f"👋 {self.name}: session ended ({data.get('reason')})."]
        return []

    async def _do_work(self):
        """The single spot where a real task/LLM/tool call happens. Runs while the
        agent holds the conch (WORKING), so no one interrupts."""
        m = self.m
        task = self.pending or ""
        if self.llm:
            try:
                out = await asyncio.to_thread(self.llm.complete, WORKER_SYSTEM, task)
                out = (out or "").strip() or "(empty response)"
            except Exception as e:
                out = f"error contacting LLM ({self.llm.describe()}): {e}"
        else:
            out = f"done: {task} → OK (scripted, no tools yet)"
        short = out if len(out) <= 160 else out[:157] + "…"
        return [f"📋 {self.name}: {short} — back in standby.",
                m.result(out, to=m.initiator, standby=True)]


def main():
    ap = argparse.ArgumentParser(description="PKM live session agent")
    ap.add_argument("--role", required=True, help="Commander | Worker")
    ap.add_argument("--name", default=os.environ.get("PKM_CHAT_NAME", "agent"))
    ap.add_argument("--url", default=os.environ.get("PKM_CHAT_URL", ""))
    ap.add_argument("--secret", default=os.environ.get("PKM_CHAT_SECRET", ""))
    ap.add_argument("--room", default=os.environ.get("PKM_CHAT_ROOM", ""))
    ap.add_argument("--mode", default="referee", choices=["referee", "p2p"])
    ap.add_argument("--initiate", action="store_true", help="open the session")
    ap.add_argument("--tasks", nargs="*", default=[], help="commander's command queue")
    ap.add_argument("--roles", nargs="*", default=["Commander", "Worker"])
    ap.add_argument("--topic", default="task queue")
    ap.add_argument("--no-narrate", action="store_true", help="don't post plain-text status lines")
    ap.add_argument("--converse", action="store_true",
                    help="directed standby mode: respond to @name/@all until the Host uses /stop")
    ap.add_argument("--system", default="", help="system prompt for directed standby mode")
    ap.add_argument("--poll", type=float, default=3.0, help="standby poll interval seconds")
    ap.add_argument("--backend", default=os.environ.get("PKM_LLM_BACKEND", ""),
                    help="LLM backend: mock | openai | vllm | pyparus | human")
    ap.add_argument("--llm-url", default=os.environ.get("PKM_LLM_BASE_URL", ""))
    ap.add_argument("--llm-model", default=os.environ.get("PKM_LLM_MODEL", ""))
    args = ap.parse_args()

    url, secret = args.url.strip(), args.secret.strip()
    if not url or not secret:
        raise SystemExit("PKM_CHAT_URL and PKM_CHAT_SECRET (or --url/--secret) are required")
    room = args.room.strip() or unquote(urlsplit(url).path.lstrip("/"))

    # An LLM is needed by the worker (structured) or any directed-standby agent.
    llm = None
    if args.backend and (args.converse or args.role == "Worker"):
        llm = AiClient.from_env(backend=args.backend or None,
                                base_url=args.llm_url or None,
                                model=args.llm_model or None)
        log(f"LLM backend: {llm.describe()}")

    agent = LiveAgent(url=url, secret=secret, name=args.name, room=room,
                      role=args.role, mode=args.mode, initiate=args.initiate,
                      tasks=args.tasks, roles=args.roles, topic=args.topic,
                      narrate=not args.no_narrate, llm=llm,
                      converse=args.converse, system_prompt=args.system, poll_interval=args.poll)
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
