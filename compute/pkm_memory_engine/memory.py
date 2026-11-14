"""Memory policy: intent association, lazy summaries, statement growth and context assembly.

The policy never calls a model. Each turn is a resumable step machine: when a model is needed it
returns {"status": "model", "request": ...}; the caller runs any provider and resumes with the text.
Turn state is persisted, so a worker restart can resume or the caller can report a model failure.
"""
from __future__ import annotations

from functools import wraps
import hashlib
import json
import math
import re
from typing import Any

from .engine import Engine, MemoryError, text

POLICY_VERSION = "pkm-memory-policy/1"
CHUNK_CHARS = 16000
SUMMARY_RAW_LIMIT = 4000
SUMMARY_DELTA_LIMIT = 3000
MAX_SUMMARIES_PER_TURN = 3
MAX_CANDIDATES = 16
MAX_EARLIER_MESSAGES = 3


def _model_observation(usage: dict | None, accounting: dict | None) -> dict:
    result = {}
    if usage is not None:
        if not isinstance(usage, dict) or set(usage) - {"inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "copilotNanoAiu"}:
            raise MemoryError("Invalid Memory provider usage.")
        if any(type(usage.get(key)) is not int or not 0 <= usage[key] <= 2**53 - 1 for key in ("inputTokens", "outputTokens")):
            raise MemoryError("Invalid Memory provider usage.")
        for key, maximum in (("reasoningTokens", "outputTokens"), ("cachedInputTokens", "inputTokens")):
            if key in usage and (type(usage[key]) is not int or not 0 <= usage[key] <= usage[maximum]):
                raise MemoryError("Invalid Memory provider usage.")
        if "copilotNanoAiu" in usage and (type(usage["copilotNanoAiu"]) is not int or not 0 <= usage["copilotNanoAiu"] <= 2**53 - 1):
            raise MemoryError("Invalid Memory provider credit usage.")
        result["usage"] = usage
    if accounting is not None:
        if not isinstance(accounting, dict) or accounting.get("schema") != "pkm.memory.model-accounting/v1":
            raise MemoryError("Invalid Memory model accounting.")
        text(accounting.get("modelId"), "modelId", 512)
        if accounting.get("provider") not in ("http", "vscode"):
            raise MemoryError("Invalid Memory model provider.")
        duration = accounting.get("durationMs")
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
            raise MemoryError("Invalid Memory model duration.")
        for key in ("timeoutMs", "maxOutputTokens"):
            if type(accounting.get(key)) is not int or not 1 <= accounting[key] <= 2**53 - 1:
                raise MemoryError("Invalid Memory configured limit.")
        thinking = accounting.get("thinkingBudget")
        if thinking != "unlimited" and (type(thinking) is not int or not 0 <= thinking <= 2**53 - 1):
            raise MemoryError("Invalid Memory thinking budget.")
        timing = accounting.get("inferenceTiming")
        if timing is not None:
            if not isinstance(timing, dict) or timing.get("schema") != "pkm.chat.inference-timing/v1" or timing.get("provider") != accounting["provider"]:
                raise MemoryError("Invalid Memory inference timing.")
            elapsed = timing.get("elapsedMs")
            if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
                raise MemoryError("Invalid Memory inference timing.")
            for key in ("maxInactivityMs", "firstActivityMs", "firstPublicOutputMs"):
                if key not in timing and key != "maxInactivityMs":
                    continue
                value = timing.get(key)
                if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= elapsed:
                    raise MemoryError("Invalid Memory inference timing.")
        result["accounting"] = accounting
    return result

INTENT_SYSTEM = """You organize the memory of one conversation into topics. Decide which topics the
CURRENT user input continues or needs. Rules:
- A follow-up, clarification, objection or sub-question inside the active discussion keeps that topic as
  focus. Short references ("this problem", "上面说的", "继续") refer to the active/most recent topic.
- Create a new topic only for a genuinely new subject. A sub-problem of an existing topic is a new topic
  whose parent is that topic. Labels are short noun phrases in the conversation's language.
- related = other topics whose established knowledge is needed to answer well (not merely similar words).
- Never invent topic aliases. Output one JSON object only:
{"focus":["T1"|"new:1"],"related":["T2"],"new":[{"key":"new:1","label":"...","parent":"T1"|null}],"reason":"one sentence"}"""

SUMMARY_SYSTEM = """You maintain the current understanding of one memory topic. Statements are appended
over time and may contradict each other: later user-confirmed or verified statements supersede earlier
ones; keep a conflict explicit only if it is unresolved. Keep goals, decisions, constraints, conclusions,
results, status and open questions. Drop back-and-forth, pleasantries and superseded drafts. Cite statement
numbers like [s12] after each claim. Write in the conversation's language. At most 350 words. Output the
summary text only."""

EXTRACT_SYSTEM = """You record what one conversation exchange contributed to memory topics. Extract at most
6 durable statements: user requirements/preferences/decisions (status "user-confirmed"), conclusions,
designs or plans proposed by the assistant ("proposal"), facts observed from tools or results
("observation"; "verified" only if a check actually passed), and disagreements ("disputed"). Each statement
must stand alone (no "this"/"above"), be at most 2 sentences, and use the conversation's language.
Skip chit-chat. If nothing durable, return an empty list. Output one JSON object only:
{"statements":[{"topic":"T1","text":"...","status":"user-confirmed|proposal|observation|verified|disputed"}]}"""


def _hash(*parts: object) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    head = limit * 2 // 3
    return value[:head] + f"\n…[{len(value) - limit} characters omitted]…\n" + value[-(limit - head):]


def _terms(value: str) -> set[str]:
    words = re.findall(r"[\w]+", value.lower())
    terms: set[str] = set()
    for word in words:
        if re.search(r"[\u3400-\u9fff]", word):
            terms.update(word[i:i + 2] for i in range(max(1, len(word) - 1)))
        elif len(word) > 2:
            terms.add(word)
    return terms


def parse_json_object(output: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?|```$", "", output.strip(), flags=re.MULTILINE).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise MemoryError("Model output contained no JSON object.")
    value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise MemoryError("Model output must be a JSON object.")
    return value


def _atomic(method):
    """Persist a complete policy step, including its receipt and all content, or nothing."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self.engine._transaction():
            return method(self, *args, **kwargs)
    return wrapped


class Memory:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    # ---------- helpers ----------
    def _mutate(self, op: str, method: str, params: dict) -> dict:
        return self.engine.mutate(_hash(op, method)[:48], method, params)

    def _scope_piece(self, scope: str, piece_id: str) -> dict:
        piece = dict(self.engine._piece(piece_id))
        if piece["scope"] != scope:
            raise MemoryError("Piece is outside this memory scope.")
        return piece

    def _statements(self, piece_id: str, after: int = 0, char_limit: int = 80000) -> list[dict]:
        rows: list[dict] = []
        size = 0
        while True:
            page = self.engine.read(piece_id, after=after, limit=100)
            for row in page["statements"]:
                if row["body"] is None:
                    continue
                rows.append(row)
                size += len(row["body"])
            if not page["statements"] or page["next"] == after or size >= char_limit:
                return rows
            after = page["next"]

    def _state_key(self, scope: str) -> str:
        return "scope:" + _hash(scope)[:40]

    def _scope_state(self, scope: str) -> dict:
        return self.engine.turn_get(self._state_key(scope)) or {"focus": []}

    def _save(self, state: dict) -> None:
        self.engine.turn_put(state["turn"], state["scope"], state)

    def _source(self, scope: str, message: dict) -> dict:
        revision = text(message.get("revision") or _hash(message["text"])[:32], "revision", 256)
        return {"id": f"{scope}|src|{message['id']}|{revision}", "chat": scope,
                "revision": revision, "locator": f"message:{message['id']}"}

    # ---------- intent ----------
    @_atomic
    def turn_begin(self, scope: str, turn: str, input: dict, recent: list[dict] | None = None,
                   budget_chars: int = 24000, model: str = "") -> dict:
        text(scope, "scope", 1024)
        text(turn, "turn", 200)
        text(input.get("text"), "input text", 65536)
        recent = [m for m in (recent or [])[-12:] if isinstance(m, dict) and m.get("text")]
        if self.engine.turn_get(turn):
            raise MemoryError("Turn already exists; resume it with turn_continue.")
        scope_state = self._scope_state(scope)
        query = input["text"] + "\n" + "\n".join(m["text"][:400] for m in recent[-2:])
        terms = _terms(query)
        topics = self.engine.pieces(scope, "topic", limit=200)
        focus_ids = [t for t in scope_state.get("focus", []) if any(x["id"] == t for x in topics)]
        scored = sorted(topics, key=lambda t: -len(terms & _terms(t["label"] + " " + (t["summary"] or ""))))
        chosen: list[dict] = [t for t in topics if t["id"] in focus_ids]
        for item in topics[:8] + scored[:MAX_CANDIDATES]:
            if item not in chosen and len(chosen) < MAX_CANDIDATES:
                chosen.append(item)
        aliases = {f"T{i + 1}": t["id"] for i, t in enumerate(chosen)}
        state = {"policy": POLICY_VERSION, "scope": scope, "turn": turn, "phase": "intent",
                 "input": {"id": input.get("id", ""), "text": input["text"]},
                 "recent_ids": [m.get("id") for m in recent if m.get("id")], "budget": budget_chars,
                 "aliases": aliases, "previous_focus": focus_ids, "calls": [], "summaries": []}
        catalog = []
        for alias, piece_id in aliases.items():
            item = next(t for t in chosen if t["id"] == piece_id)
            brief = item["summary"] or " ".join(s["body"] for s in self._statements(piece_id, char_limit=600)[-3:])
            catalog.append({"alias": alias, "label": item["label"], "active": piece_id in focus_ids,
                            "level": item["level"], "knowledge": _clip(brief or "(no notes yet)", 500)})
        prompt = {"recent_dialogue": [{"role": m.get("role", "user"), "text": _clip(m["text"], 800)} for m in recent[-6:]],
                  "topics": catalog, "current_input": _clip(input["text"], 4000)}
        state["phase"] = "intent"
        return self._request(state, "intent", INTENT_SYSTEM, json.dumps(prompt, ensure_ascii=False), 400, model)

    def _request(self, state: dict, purpose: str, system: str, user: str, max_tokens: int, model: str = "") -> dict:
        state["pending"] = {"purpose": purpose}
        state["calls"].append({"purpose": purpose, "status": "requested",
                               "input_chars": len(system) + len(user), "max_tokens": max_tokens})
        self._save(state)
        return {"turn": state["turn"], "status": "model", "receipt": self._receipt(state),
                "request": {"purpose": purpose, "max_tokens": max_tokens,
                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}}

    @_atomic
    def _new_topic(self, state: dict, key: str, label: str, parent: str | None) -> str:
        piece = f"{state['scope']}|t|{_hash(state['turn'], key)[:20]}"
        self._mutate(f"{state['turn']}:topic:{key}", "create",
                     {"piece": piece, "label": text(label.strip() or "Untitled topic", "label", 1024),
                      "kind": "topic", "scope": state["scope"]})
        if parent:
            self._mutate(f"{state['turn']}:topic-parent:{key}", "link",
                         {"parent": parent, "child": piece, "relation": "abstracts"})
        state.setdefault("created", {})[key] = piece
        return piece

    @_atomic
    def turn_continue(self, turn: str, output: str = "", error: str = "", usage: dict | None = None,
                      accounting: dict | None = None) -> dict:
        state = self.engine.turn_get(turn)
        if not state or "pending" not in state:
            raise MemoryError("No pending model step for this turn.")
        observation = _model_observation(usage, accounting)
        purpose = state.pop("pending")["purpose"]
        call = state["calls"][-1]
        call.update({"status": "failed" if error else "complete", "output_chars": len(output or "")})
        call.update(observation)
        if error:
            call["error"] = _clip(str(error), 500)
        if purpose == "intent":
            return self._apply_intent(state, output, error)
        if purpose == "summary":
            return self._apply_summary(state, output, error)
        if purpose == "extract":
            return self._apply_extract(state, output, error)
        raise MemoryError("Unknown pending step.")

    @_atomic
    def turn_abort(self, turn: str, error: str, usage: dict | None = None, accounting: dict | None = None) -> dict:
        state = self.engine.turn_get(turn)
        if not state or "pending" not in state:
            raise MemoryError("No pending model step for this turn.")
        observation = _model_observation(usage, accounting)
        text(error, "cancellation reason", 1024)
        state.pop("pending")
        state["calls"][-1].update({"status": "cancelled", "error": error, **observation})
        state["phase"] = "cancelled"
        self._save(state)
        return {"turn": turn, "status": "done", "receipt": self._receipt(state)}

    def _apply_intent(self, state: dict, output: str, error: str) -> dict:
        aliases = state["aliases"]
        intent: dict[str, Any] = {"status": "model", "focus": [], "related": [], "created": []}
        try:
            with self.engine._transaction():
                if error:
                    raise MemoryError(error)
                value = parse_json_object(output)
                new = value.get("new") or []
                if not isinstance(new, list):
                    raise MemoryError("new must be a list.")
                for item in new[:3]:
                    key, label = str(item.get("key", "")), str(item.get("label", "")).strip()
                    if not key.startswith("new:") or not label:
                        continue
                    parent = item.get("parent")
                    parent_id = aliases.get(parent) or state.get("created", {}).get(parent) if parent else None
                    intent["created"].append(self._new_topic(state, key, label[:120], parent_id))
                resolve = lambda alias: aliases.get(alias) or state.get("created", {}).get(alias)
                intent["focus"] = list(dict.fromkeys(p for p in map(resolve, value.get("focus") or []) if p))[:3]
                intent["related"] = [p for p in dict.fromkeys(map(resolve, value.get("related") or []))
                                     if p and p not in intent["focus"]][:5]
                intent["reason"] = _clip(str(value.get("reason", "")), 300)
                if not intent["focus"]:
                    raise MemoryError("Intent selected no valid focus topic.")
        except (MemoryError, ValueError, TypeError, AttributeError) as failure:
            # Visible fallback: keep the active topic; never silently drop the conversation thread.
            state.pop("created", None)
            intent["created"] = []
            intent["focus"] = []
            intent["related"] = []
            intent.update({"status": "fallback", "error": _clip(str(failure), 300)})
            intent["focus"] = intent["focus"] or state["previous_focus"][:1]
            if not intent["focus"]:
                intent["focus"] = [self._new_topic(state, "fallback", _clip(state["input"]["text"].strip().splitlines()[0], 60), None)]
        state["intent"] = intent
        return self._after_intent(state)

    # ---------- lazy summary ----------
    def _topic_material(self, piece_id: str) -> dict:
        page = self.engine.read(piece_id, limit=1)
        piece, summary = page["piece"], page["summary"]
        through = summary["through"] if summary else 0
        statements = self._statements(piece_id)
        delta = [s for s in statements if s["sequence"] > through]
        subtopics = [c for c in self.engine.children(piece_id, limit=30, kind="topic")["children"] if not c["evicted"]]
        return {"piece": piece, "summary": summary, "current": page["summary_current"],
                "statements": statements, "delta": delta, "subtopics": subtopics}

    def _needs_summary(self, material: dict) -> bool:
        if material["current"]:
            return False
        if material["summary"]:
            # Message links and child summaries also bump revision; only new knowledge justifies a rewrite.
            return sum(len(s["body"]) for s in material["delta"]) > SUMMARY_DELTA_LIMIT
        return sum(len(s["body"]) for s in material["statements"]) > SUMMARY_RAW_LIMIT

    def _after_intent(self, state: dict) -> dict:
        focus, related = state["intent"]["focus"], state["intent"]["related"]
        state["queue"] = [p for p in focus + related if self._needs_summary(self._topic_material(p))][:MAX_SUMMARIES_PER_TURN]
        scope_state = {"turn": self._state_key(state["scope"]), "scope": state["scope"], "focus": focus}
        self._save(scope_state)
        return self._next_summary(state)

    def _next_summary(self, state: dict) -> dict:
        if not state["queue"]:
            return self._ready(state)
        piece_id = state["queue"][0]
        material = self._topic_material(piece_id)
        state["summary_revision"] = material["piece"]["revision"]
        state["summary_through"] = max([s["sequence"] for s in material["statements"]], default=0)
        sub = []
        for child in material["subtopics"]:
            summary = self.engine.read(child["id"], limit=1)["summary"]
            sub.append(f"- {child['label']}: " + _clip(summary["body"] if summary else "(not summarized)", 600))
        if material["summary"]:
            body = (f"Topic: {material['piece']['label']}\nPrevious summary:\n{material['summary']['body']}\n\n"
                    "New statements since then:\n" + "\n".join(f"[s{s['sequence']}] ({s['status']}) {s['body']}" for s in material["delta"]))
            mode = "incremental"
        else:
            body = f"Topic: {material['piece']['label']}\nStatements:\n" + "\n".join(
                f"[s{s['sequence']}] ({s['status']}) {s['body']}" for s in material["statements"])
            mode = "full"
        if sub:
            body += "\n\nSub-topics:\n" + "\n".join(sub)
        state["summaries"].append({"piece": piece_id, "mode": mode, "status": "requested"})
        state["phase"] = "summary"
        return self._request(state, "summary", SUMMARY_SYSTEM, _clip(body, 60000), 900)

    def _apply_summary(self, state: dict, output: str, error: str) -> dict:
        piece_id = state["queue"].pop(0)
        record = state["summaries"][-1]
        body = (output or "").strip()
        if error or not body:
            record.update({"status": "failed", "error": _clip(error or "empty summary", 300)})
        else:
            try:
                self._mutate(f"{state['turn']}:summary:{piece_id}", "summary_commit",
                             {"piece": piece_id, "expected_revision": state["summary_revision"],
                              "body": body[:30000], "through": state["summary_through"]})
                record["status"] = "committed"
            except MemoryError as failure:
                record.update({"status": "transient", "error": str(failure), "body": body[:30000]})
        return self._next_summary(state)

    # ---------- context ----------
    def _topic_block(self, state: dict, piece_id: str, limit: int) -> str:
        material = self._topic_material(piece_id)
        transient = next((s.get("body") for s in state["summaries"] if s["piece"] == piece_id and s.get("body")), None)
        lines = [f"Memory topic «{material['piece']['label']}» (piece {piece_id})"]
        if material["summary"] and (material["current"] or transient is None):
            lines.append("Current understanding:" if material["current"] or not material["delta"] else "Earlier understanding (newer notes follow):")
            lines.append(material["summary"]["body"])
            newer = material["delta"]
        elif transient:
            lines += ["Current understanding:", transient]
            newer = []
        else:
            newer = material["statements"]
        if newer:
            lines.append("Notes:" if not material["summary"] else "Newer notes:")
            lines += [f"[s{s['sequence']}] ({s['status']}) {s['body']}" for s in newer[-30:]]
        if material["subtopics"]:
            lines.append("Sub-topics: " + "; ".join(f"{c['label']} ({c['id']})" for c in material["subtopics"][:12]))
        return _clip("\n".join(lines), limit)

    def _ready(self, state: dict) -> dict:
        budget = state["budget"]
        focus, related = state["intent"]["focus"], state["intent"]["related"]
        blocks: list[dict] = []
        for index, piece_id in enumerate(focus):
            blocks.append({"kind": "focus-topic", "piece": piece_id, "priority": 300 - index,
                           "text": self._topic_block(state, piece_id, max(2000, budget // 3))})
        recent = set(state["recent_ids"])
        earlier: list[dict] = []
        for piece_id in focus:
            for child in self.engine.children(piece_id, limit=40, kind="message")["children"]:
                message_id = child["id"].rsplit("|m|", 1)[1]
                if child["evicted"] or message_id in recent or any(e["piece"] == child["id"] for e in earlier):
                    continue
                earlier.append({"piece": child["id"], "label": child["label"]})
        for index, item in enumerate(earlier[:MAX_EARLIER_MESSAGES]):
            body = "".join(s["body"] for s in self._statements(item["piece"], char_limit=24000))
            blocks.append({"kind": "earlier-message", "piece": item["piece"], "priority": 250 - index,
                           "text": f"Earlier message in the focused topic ({item['label']}):\n" + _clip(body, 6000)})
        for index, piece_id in enumerate(related):
            blocks.append({"kind": "related-topic", "piece": piece_id, "priority": 200 - index,
                           "text": self._topic_block(state, piece_id, 2500)})
        others = [t for t in self.engine.pieces(state["scope"], "topic", limit=24) if t["id"] not in focus + related][:12]
        if others:
            blocks.append({"kind": "index", "piece": "", "priority": 100,
                           "text": "Other memory topics in this Chat (use memory_read with the piece id if needed): "
                                   + "; ".join(f"{t['label']} ({t['id']})" for t in others)})
        used, selected = 0, []
        for block in sorted(blocks, key=lambda b: -b["priority"]):
            if used + len(block["text"]) > budget and selected:
                block["omitted"] = True
                continue
            used += len(block["text"])
            selected.append(block)
        for block in selected:
            if block["piece"]:
                self._mutate(f"{state['turn']}:touch:{block['piece']}", "touch", {"piece": block["piece"], "reason": "sent"})
        state["phase"] = "ready"
        state["context"] = {"blocks": [{k: v for k, v in b.items() if k != "text"} | {"chars": len(b["text"])} for b in blocks]}
        self._save(state)
        return {"turn": state["turn"], "status": "ready", "receipt": self._receipt(state),
                "context": {"blocks": selected, "focus": focus, "related": related}}

    # ---------- growth ----------
    @_atomic
    def _ingest(self, state: dict, message: dict, role: str) -> str:
        scope = state["scope"]
        source = self._source(scope, message)
        piece = f"{scope}|m|{message['id']}"
        label = f"{message['id']} {role}: " + _clip(" ".join(message["text"].split()), 80)
        try:
            self.engine._piece(piece)
            exists = True
        except MemoryError:
            exists = False
        if not exists:
            self._mutate(f"msg:{piece}", "create", {"piece": piece, "label": label[:1024], "kind": "message", "scope": scope})
            body = message["text"]
            for index in range(0, max(1, len(body)), CHUNK_CHARS):
                revision = self.engine._piece(piece)["revision"]
                self._mutate(f"msg:{piece}:{source['revision']}:{index}", "append",
                             {"piece": piece, "expected_revision": revision, "statement_id": f"{piece}|{source['revision'][:16]}|{index}",
                              "body": body[index:index + CHUNK_CHARS] or "(empty)", "status": "observation", "sources": [source]})
        for topic in state["intent"]["focus"]:
            if not any(p["id"] == topic for p in self.engine.parents(piece)):
                self._mutate(f"{state['turn']}:link:{topic}:{piece}", "link", {"parent": topic, "child": piece, "relation": "abstracts"})
        return piece

    @_atomic
    def turn_commit(self, turn: str, user: dict, assistant: dict, scope: str = "", model: str = "") -> dict:
        state = self.engine.turn_get(turn)
        if not state:
            if not scope:
                raise MemoryError("Unknown turn; pass scope to ingest without intent analysis.")
            focus = self._scope_state(scope).get("focus", [])
            state = {"policy": POLICY_VERSION, "scope": scope, "turn": turn, "phase": "ready", "aliases": {},
                     "intent": {"status": "inherited", "focus": focus, "related": [], "created": []},
                     "recent_ids": [], "calls": [], "summaries": [], "budget": 0}
        if state["phase"] not in ("ready", "done"):
            raise MemoryError("Turn context was never prepared; cannot commit.")
        if state["phase"] == "done":
            return {"turn": turn, "status": "done", "receipt": self._receipt(state)}
        for message in (user, assistant):
            text(message.get("id"), "message id", 256)
            text(message.get("text"), "message text", 10 * 1024 * 1024)
        state["messages"] = {"user": self._ingest(state, user, "user"), "assistant": self._ingest(state, assistant, "assistant")}
        state["sources"] = [self._source(state["scope"], user), self._source(state["scope"], assistant)]
        focus = state["intent"]["focus"]
        if not focus:
            state["phase"] = "done"
            self._save(state)
            return {"turn": turn, "status": "done", "receipt": self._receipt(state)}
        aliases = {f"T{i + 1}": p for i, p in enumerate(focus)}
        state["extract_aliases"] = aliases
        topics = []
        for alias, piece_id in aliases.items():
            material = self._topic_material(piece_id)
            known = material["summary"]["body"] if material["summary"] else " ".join(s["body"] for s in material["statements"][-5:])
            topics.append({"alias": alias, "label": material["piece"]["label"], "known": _clip(known or "(empty)", 1200)})
        prompt = json.dumps({"topics": topics, "user": _clip(user["text"], 6000), "assistant": _clip(assistant["text"], 12000)}, ensure_ascii=False)
        state["phase"] = "extract"
        return self._request(state, "extract", EXTRACT_SYSTEM, prompt, 900, model)

    def _apply_extract(self, state: dict, output: str, error: str) -> dict:
        added = []
        try:
            with self.engine._transaction():
                if error:
                    raise MemoryError(error)
                items = parse_json_object(output).get("statements") or []
                if not isinstance(items, list):
                    raise MemoryError("statements must be a list.")
                for index, item in enumerate(items[:6]):
                    piece_id = state["extract_aliases"].get(str(item.get("topic")))
                    body = str(item.get("text", "")).strip()
                    status = item.get("status") if item.get("status") in {"proposal", "observation", "user-confirmed", "verified", "disputed"} else "proposal"
                    if not piece_id or not body:
                        continue
                    revision = self.engine._piece(piece_id)["revision"]
                    self._mutate(f"{state['turn']}:statement:{index}", "append",
                                 {"piece": piece_id, "expected_revision": revision,
                                  "statement_id": f"{piece_id}|{_hash(state['turn'], index)[:20]}",
                                  "body": _clip(body, 1500), "status": status, "sources": state["sources"]})
                    added.append({"piece": piece_id, "status": status})
                state["extract"] = {"status": "model", "added": added}
        except (MemoryError, ValueError, TypeError, AttributeError) as failure:
            state["extract"] = {"status": "failed", "error": _clip(str(failure), 300), "added": []}
        state["phase"] = "done"
        self._save(state)
        return {"turn": state["turn"], "status": "done", "receipt": self._receipt(state)}

    # ---------- reading, lifecycle and visualization ----------
    @_atomic
    def memory_read(self, scope: str, piece: str, after: int = 0) -> dict:
        info = self._scope_piece(scope, piece)
        if info["evicted"]:
            return {"piece": piece, "label": info["label"], "evicted": True,
                    "note": "Content was evicted from memory; the original Chat history may still hold it."}
        page = self.engine.read(piece, after=after, limit=40)
        missing = page["status"] == "missing"
        more = self.engine.read(piece, after=page["next"], limit=1)["statements"]
        children = self.engine.children(piece, limit=30)["children"]
        if not missing:
            self._mutate(f"read:{piece}:{info['revision']}:{after}", "touch", {"piece": piece, "reason": "expand"})
        return {"piece": piece, "label": info["label"], "kind": info["kind"], "level": info["level"],
                "summary": page["summary"]["body"] if page["summary"] else None, "summary_current": page["summary_current"],
                "statements": [{"n": s["sequence"], "status": s["status"], "text": s["body"]} for s in page["statements"] if s["body"]],
                "next": page["next"] if more else None,
                "children": [{"piece": c["id"], "label": c["label"], "kind": c["kind"], "evicted": bool(c["evicted"])} for c in children],
                "parents": [{"piece": p["id"], "label": p["label"]} for p in self.engine.parents(piece)]} | (
                    {"status": "missing", "note": "Memory content is missing; reconstruct it from the original Chat history."}
                    if missing else {})

    def overview(self, scope: str, limit: int = 100) -> dict:
        topics = self.engine.pieces(scope, "topic", limit=min(limit, 200))
        nodes, edges = [], []
        for topic in topics:
            children = self.engine.children(topic["id"], limit=100)["children"]
            nodes.append({"piece": topic["id"], "label": topic["label"], "level": topic["level"], "bytes": topic["bytes"],
                          "summary": topic["summary"], "summary_current": bool(topic["summary_current"]),
                          "messages": sum(1 for c in children if c["kind"] == "message"),
                          "statements": len(self._statements(topic["id"], char_limit=10**9))})
            edges += [{"parent": topic["id"], "child": c["id"]} for c in children if c["kind"] == "topic"]
        return {"scope": scope, "topics": nodes, "edges": edges, "usage": self.engine.usage(scope)}

    def turn_receipt(self, turn: str) -> dict:
        state = self.engine.turn_get(turn)
        if not state:
            raise MemoryError("Unknown turn.")
        return self._receipt(state)

    @_atomic
    def enforce_capacity(self, max_bytes: int, protected: list[str] | None = None) -> dict:
        evicted: list[str] = []
        while (used := self.engine.usage()["bytes"]) > max_bytes:
            sequence = self.engine.db.execute("SELECT COALESCE(MAX(sequence),0) FROM changes").fetchone()[0]
            result = self.engine.mutate(_hash("capacity", used, sequence, protected or [])[:48], "evict",
                                        {"count": 100, "protected": protected or [], "free_bytes": used - max_bytes})
            if not result["evicted"]:
                break
            evicted += result["evicted"]
        return {"evicted": evicted, "usage": self.engine.usage()}

    @_atomic
    def forget_scope(self, scope: str) -> dict:
        return self._mutate(f"forget-scope:v2:{scope}", "purge_chat", {"chat": scope})

    def _receipt(self, state: dict) -> dict:
        return {"schema": "pkm.memory.turn-receipt/v1", "policy": state.get("policy"), "turn": state["turn"],
                "phase": state["phase"], "intent": state.get("intent"), "calls": state["calls"],
                "summaries": [{k: v for k, v in s.items() if k != "body"} for s in state["summaries"]],
                "context": state.get("context"), "extract": state.get("extract"), "messages": state.get("messages")}
