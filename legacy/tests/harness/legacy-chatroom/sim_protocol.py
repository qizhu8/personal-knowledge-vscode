"""
In-process simulation of the agent-to-agent session protocol — NO network, NO LLM.

It wires N SessionMachines to a shared broadcast "bus" (mimicking the chatroom:
every frame is delivered to every other member, in order) and drives them with
tiny *scripted* brains. This proves the handshake, turn-token, piggybacked ACK,
and teardown work end-to-end before any model or WebSocket is involved.

Run: python sim_protocol.py
"""
from __future__ import annotations

import collections
from protocol import SessionMachine


class Agent:
    def __init__(self, name, role, brain):
        self.name = name
        self.m = SessionMachine(name, role=role)
        self.brain = brain          # brain(agent, event, data) -> list[frame]
        self.role = role


class Bus:
    """A broadcast message bus: mimics a chatroom where every member sees every
    message in a single global order."""

    def __init__(self):
        self.agents: list[Agent] = []
        self.q: collections.deque = collections.deque()
        self.transcript: list[str] = []

    def add(self, a: Agent):
        self.agents.append(a)

    def broadcast(self, sender: str, frames: list[dict]):
        for fr in frames or []:
            self.q.append((sender, fr))

    def _log(self, fr: dict):
        t = fr.get("t")
        if t == "turn":
            self.transcript.append(
                f"[r{fr.get('meta',{}).get('round')}] {fr['from']}->{fr.get('to')} "
                f"{fr.get('kind')}: {fr.get('payload')} (grant={fr.get('grant')})")
        elif t in ("open", "join", "start", "end", "end_ack"):
            self.transcript.append(f"        <{t}> {fr['from']} {fr.get('meta',{})}")

    def run(self, max_steps=200) -> bool:
        steps = 0
        while self.q and steps < max_steps:
            steps += 1
            sender, fr = self.q.popleft()
            self._log(fr)
            for a in self.agents:
                if a.name == sender and fr.get("t") != "open":
                    continue
                events, out = a.m.on_frame(fr)
                self.broadcast(a.name, out)
                for ev, data in events:
                    self.broadcast(a.name, a.brain(a, ev, data) or [])
                # Runtime work phase: once an agent enters WORKING (after ack),
                # let it actually do the task, then report via `result`.
                if a.m.agent_state == SessionMachine.WORKING and not getattr(a, "_busy", False):
                    a._busy = True
                    self.broadcast(a.name, a.brain(a, "work", {}) or [])
                    a._busy = False
        return all(a.m.state == SessionMachine.CLOSED for a in self.agents)


# ── scripted brains ─────────────────────────────────────────────────────────
def judge_brain(a: Agent, ev: str, data: dict):
    """Referee: alternately calls Generator then Discriminator; stops at max_rounds."""
    m = a.m
    if ev != "granted":
        return []
    kind = data.get("kind")
    if kind in ("start", "critique"):
        # Begin/continue a round -> ask Generator to (re)produce.
        if kind == "critique":
            if m.round >= (m.max_rounds or 3):
                return [m.end(reason="max_rounds", verdict=m.role_of.get("Generator"))]
            m.round += 1
        gen = m.role_of["Generator"]
        fb = f" (fix: {data.get('payload')})" if kind == "critique" else ""
        return [m.turn("control", f"round {m.round}: produce candidate{fb}", to=gen, grant=gen)]
    if kind == "candidate":
        dis = m.role_of["Discriminator"]
        return [m.turn("control", "evaluate the candidate", to=dis, grant=dis)]
    return []


def generator_brain(a: Agent, ev: str, data: dict):
    m = a.m
    if ev != "granted":
        return []
    judge = m.role_of.get("Judge")
    target = judge or m.role_of.get("Discriminator")
    # p2p end: if we've hit the cap, close instead of speaking again.
    if not judge and m.round > (m.max_rounds or 3):
        return [m.end(reason="max_rounds", verdict=m.me)]
    return [m.turn("candidate", f"candidate-v{m.round}", to=target, grant=target)]


def discriminator_brain(a: Agent, ev: str, data: dict):
    m = a.m
    if ev != "granted":
        return []
    judge = m.role_of.get("Judge")
    target = judge or m.role_of.get("Generator")
    score = round(0.5 + 0.1 * m.round, 2)
    if not judge:
        m.round += 1  # in p2p the round advances when D hands back to G
    return [m.turn("critique", f"score={score}; tighten intro", to=target, grant=target)]


def run_referee():
    print("=== referee mode: Generator + Discriminator + Judge ===")
    bus = Bus()
    judge = Agent("Judy", "Judge", judge_brain)
    gen = Agent("Gina", "Generator", generator_brain)
    dis = Agent("Dan", "Discriminator", discriminator_brain)
    for a in (judge, gen, dis):
        bus.add(a)
    # Human/initiator = Judge opens the session and grants itself the first token.
    bus.broadcast(judge.name, judge.m.open(
        topic="write a haiku", roles=["Judge", "Generator", "Discriminator"],
        mode="referee", max_rounds=3, first_speaker="Judy"))
    ok = bus.run()
    for line in bus.transcript:
        print("  " + line)
    print(f"  -> all closed: {ok}, rounds: {judge.m.round}\n")
    return ok


def run_p2p():
    print("=== p2p mode: Generator + Discriminator (no judge) ===")
    bus = Bus()
    gen = Agent("Gina", "Generator", generator_brain)
    dis = Agent("Dan", "Discriminator", discriminator_brain)
    for a in (gen, dis):
        bus.add(a)
    bus.broadcast(gen.name, gen.m.open(
        topic="debate: tabs vs spaces", roles=["Generator", "Discriminator"],
        mode="p2p", max_rounds=3, first_speaker="Gina"))
    ok = bus.run()
    for line in bus.transcript:
        print("  " + line)
    print(f"  -> all closed: {ok}, rounds: {gen.m.round}\n")
    return ok


# ── standby / command / ack / work / result lifecycle ───────────────────────
def commander_brain(a: Agent, ev: str, data: dict):
    """Human/commander: hands out queued commands one at a time; each is only
    issued after the previous task's `result` returns the conch."""
    m = a.m
    if ev != "granted":
        return []
    if not hasattr(a, "todo"):
        a.todo = ["analyze log A", "summarize folder B"]
    kind = data.get("kind")
    if kind in ("start", "result"):
        worker = m.role_of.get("Worker")
        if a.todo:
            return [m.turn("command", a.todo.pop(0), to=worker, grant=worker)]
        return [m.end(reason="all tasks done", verdict="Worker")]
    return []


def worker_brain(a: Agent, ev: str, data: dict):
    """Designated agent: ACK a command (enter WORKING, keep the conch), do the
    task, then `result` with standby=True (back to STANDBY, conch handed back)."""
    m = a.m
    if ev == "granted" and data.get("kind") == "command":
        a.pending = data.get("payload")
        return [m.ack(to=data.get("from"))]          # ack receipt -> WORKING
    if ev == "work":
        out = f"done: {a.pending} -> OK (42 lines)"
        return [m.result(out, to=m.initiator, standby=True)]  # result + re-standby
    return []


def run_standby():
    print("=== standby lifecycle: Commander + Worker (command/ack/work/result) ===")
    bus = Bus()
    cmdr = Agent("Boss", "Commander", commander_brain)
    work = Agent("Wanda", "Worker", worker_brain)
    for a in (cmdr, work):
        bus.add(a)
    bus.broadcast(cmdr.name, cmdr.m.open(
        topic="task queue", roles=["Commander", "Worker"],
        mode="referee", max_rounds=99, first_speaker="Boss"))
    ok = bus.run()
    for line in bus.transcript:
        print("  " + line)
    print(f"  -> all closed: {ok}, worker end-state: {work.m.agent_state}\n")
    return ok and work.m.agent_state == SessionMachine.STANDBY


if __name__ == "__main__":
    r1 = run_referee()
    r2 = run_p2p()
    r3 = run_standby()
    print("RESULT:", "PASS" if (r1 and r2 and r3) else "FAIL")
