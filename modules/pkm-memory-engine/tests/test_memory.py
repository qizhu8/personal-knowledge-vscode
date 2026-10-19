"""Standalone policy tests: a scripted model drives Intent, Lazy Summary and statement growth."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from pkm_memory_engine import Engine, Memory, MemoryError

SCOPE = "ns/chat-1"


class Script:
    """Records each model request and answers from a per-purpose queue."""

    def __init__(self, **answers):
        self.answers = {key: list(value) for key, value in answers.items()}
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        queue = self.answers.get(request["purpose"], [])
        if not queue:
            raise AssertionError(f"Unexpected {request['purpose']} request")
        answer = queue.pop(0)
        return answer(request) if callable(answer) else answer


def alias(request, label):
    return next(t["alias"] for t in json.loads(request["messages"][1]["content"])["topics"] if t["label"] == label)


def run(memory, step, model):
    while step["status"] == "model":
        output = model(step["request"])
        if isinstance(output, Exception):
            step = memory.turn_continue(step["turn"], error=str(output))
        else:
            step = memory.turn_continue(step["turn"], output=output if isinstance(output, str) else json.dumps(output, ensure_ascii=False))
    return step


class MemoryPolicyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memory.sqlite"
        self.engine = Engine(self.path, "root|account")
        self.memory = Memory(self.engine)
        self.history = []

    def tearDown(self):
        self.engine.close()
        self.dir.cleanup()

    def turn(self, turn, user, reply, model, budget=24000):
        user_message = {"id": f"u{turn}", "text": user}
        step = run(self.memory, self.memory.turn_begin(SCOPE, f"turn-{turn}", user_message, self.history[-6:], budget), model)
        self.assertEqual(step["status"], "ready")
        done = run(self.memory, self.memory.turn_commit(f"turn-{turn}", user_message, {"id": f"a{turn}", "text": reply}), model)
        self.assertEqual(done["status"], "done")
        self.history += [{"id": f"u{turn}", "role": "user", "text": user}, {"id": f"a{turn}", "role": "assistant", "text": reply}]
        return step, done

    def topic(self, label):
        return next(t for t in self.engine.pieces(SCOPE, "topic") if t["label"] == label)

    def test_reference_to_previous_problem_keeps_focus_and_restores_long_answer(self):
        long_review = "Skill review: 1. trigger rules are vague. " + "detail " * 600 + "2. missing validation steps."
        model = Script(
            intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Skills review", "parent": None}], "reason": "new"},
                    lambda request: {"focus": [next(t["alias"] for t in json.loads(request["messages"][1]["content"])["topics"] if t["active"])],
                                     "related": [], "new": [], "reason": "refers to active problem"}],
            extract=[{"statements": [{"topic": "T1", "text": "The Skills review found vague trigger rules and missing validation steps.", "status": "proposal"}]},
                     {"statements": [{"topic": "T1", "text": "User wants a good design for the Skills trigger and validation problem.", "status": "user-confirmed"}]}])
        self.turn(1, "Review my Skills", long_review, model)
        self.history = self.history[:1]  # the long answer has scrolled out of the recent window
        step, _ = self.turn(2, "没错。我希望有一个好的设计，解决你上面说的这个问题", "Here is a design ...", model)
        catalog = json.loads(model.requests[2]["messages"][1]["content"])["topics"]
        self.assertTrue(catalog[0]["active"])
        blocks = step["context"]["blocks"]
        focus = next(b for b in blocks if b["kind"] == "focus-topic")
        self.assertIn("vague trigger rules", focus["text"])
        self.assertTrue(any(b["kind"] == "earlier-message" and "missing validation" in b["text"] for b in blocks))
        topic = self.topic("Skills review")
        self.assertEqual(topic["level"], 1)
        children = self.engine.children(topic["id"], kind="message")["children"]
        self.assertEqual(len(children), 4)
        statements = self.memory.memory_read(SCOPE, topic["id"])["statements"]
        self.assertEqual([s["status"] for s in statements], ["proposal", "user-confirmed"])

    def test_lazy_summary_runs_only_when_used_and_large_then_reuses(self):
        notes = [{"topic": "T1", "text": f"Decision {i}: " + "x" * 700, "status": "user-confirmed"} for i in range(6)]
        model = Script(
            intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Storage design"}]}] + [{"focus": ["T1"]}] * 4,
            extract=[{"statements": notes}, {"statements": []}, {"statements": [{"topic": "T1", "text": "Small change", "status": "proposal"}]},
                     {"statements": notes}, {"statements": []}],
            summary=["Storage uses SQLite WAL [s1]. Decisions 0-5 [s2]-[s6].", "Updated: decisions 0-5 plus later ones [s8]."])
        self.turn(1, "design storage", "ok", model)
        self.assertNotIn("summary", [r["purpose"] for r in model.requests])  # growth alone never summarizes
        step, _ = self.turn(2, "continue", "ok", model)
        self.assertEqual([r["purpose"] for r in model.requests].count("summary"), 1)
        self.assertEqual(step["receipt"]["summaries"][0]["status"], "committed")
        self.assertIn("SQLite WAL", step["context"]["blocks"][0]["text"])
        step, _ = self.turn(3, "continue", "ok", model)
        self.assertEqual([r["purpose"] for r in model.requests].count("summary"), 1)  # stale but small delta: reuse
        self.assertIn("Small change", self.memory.memory_read(SCOPE, self.topic("Storage design")["id"])["statements"][-1]["text"])
        self.turn(4, "continue", "ok", model)
        step, _ = self.turn(5, "continue", "ok", model)
        summaries = [r for r in model.requests if r["purpose"] == "summary"]
        self.assertEqual(len(summaries), 2)
        self.assertIn("Previous summary", summaries[1]["messages"][1]["content"])
        self.assertIn("Updated", step["context"]["blocks"][0]["text"])

    def test_invalid_intent_falls_back_visibly_to_active_topic(self):
        model = Script(intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Topic A"}]}, "not json", {"focus": ["T99"]}],
                       extract=[{"statements": []}] * 3)
        self.turn(1, "start A", "ok", model)
        step, _ = self.turn(2, "go on", "ok", model)
        self.assertEqual(step["receipt"]["intent"]["status"], "fallback")
        self.assertEqual(step["context"]["focus"], [self.topic("Topic A")["id"]])
        step, _ = self.turn(3, "go on", "ok", model)
        self.assertEqual(step["receipt"]["intent"]["status"], "fallback")
        self.assertIn("no valid focus", step["receipt"]["intent"]["error"])

    def test_model_failure_is_recorded_and_turn_still_ready(self):
        model = Script(intent=[RuntimeError("model offline")], extract=[RuntimeError("model offline")])
        step, done = self.turn(1, "hello there", "hi", model)
        self.assertEqual(step["receipt"]["intent"]["status"], "fallback")
        self.assertEqual(step["receipt"]["calls"][0]["status"], "failed")
        self.assertEqual(done["receipt"]["extract"]["status"], "failed")
        self.assertEqual(len(self.engine.pieces(SCOPE, "message")), 2)

    def test_subtopic_hierarchy_related_topics_and_index(self):
        model = Script(
            intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "PKM memory"}]},
                    {"focus": ["new:1"], "new": [{"key": "new:1", "label": "Eviction policy", "parent": "T1"}]},
                    {"focus": ["new:1"], "new": [{"key": "new:1", "label": "Unrelated: trip plan"}]},
                    lambda request: {"focus": [alias(request, "PKM memory")], "related": [alias(request, "Eviction policy")]}],
            extract=[{"statements": [{"topic": "T1", "text": "Memory is a multi-parent graph.", "status": "user-confirmed"}]},
                     {"statements": [{"topic": "T1", "text": "Evict lower levels first, LRU within a level.", "status": "user-confirmed"}]},
                     {"statements": []}, {"statements": []}])
        self.turn(1, "memory design", "ok", model)
        self.turn(2, "how do we evict", "ok", model)
        self.turn(3, "plan my trip", "ok", model)
        step, _ = self.turn(4, "back to memory", "ok", model)
        parent, child = self.topic("PKM memory"), self.topic("Eviction policy")
        self.assertEqual(parent["level"], 2)
        self.assertEqual(self.engine.parents(child["id"])[0]["id"], parent["id"])
        kinds = {b["kind"]: b["text"] for b in step["context"]["blocks"]}
        self.assertIn("LRU within a level", kinds["related-topic"])
        self.assertIn("Eviction policy", kinds["focus-topic"])
        self.assertIn("trip plan", kinds["index"])

    def test_scope_isolation_restart_resume_and_capacity(self):
        model = Script(intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Topic"}]}],
                       extract=[{"statements": [{"topic": "T1", "text": "Kept fact", "status": "verified"}]}])
        step = self.memory.turn_begin(SCOPE, "turn-1", {"id": "u1", "text": "hello"}, [])
        self.engine.close()
        self.engine = Engine(self.path, "root|account")  # worker restart between model steps
        self.memory = Memory(self.engine)
        step = run(self.memory, self.memory.turn_continue("turn-1", output=json.dumps(model(step["request"]))), model)
        self.assertEqual(step["status"], "ready")
        run(self.memory, self.memory.turn_commit("turn-1", {"id": "u1", "text": "hello " * 5000}, {"id": "a1", "text": "reply " * 5000}), model)
        topic = self.topic("Topic")
        with self.assertRaises(MemoryError):
            self.memory.memory_read("other/chat", topic["id"])
        before = self.engine.usage(SCOPE)["bytes"]
        result = self.memory.enforce_capacity(before - 1)
        self.assertTrue(result["evicted"])
        self.assertTrue(all("|m|" in piece for piece in result["evicted"]))
        self.assertIn("Kept fact", self.memory.memory_read(SCOPE, topic["id"])["statements"][0]["text"])
        self.assertTrue(self.memory.memory_read(SCOPE, result["evicted"][0])["evicted"])

    def test_commit_without_prepared_turn_inherits_active_focus(self):
        model = Script(intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Topic"}]}],
                       extract=[{"statements": []}, {"statements": [{"topic": "T1", "text": "Worker result arrived", "status": "observation"}]}])
        self.turn(1, "start", "ok", model)
        done = run(self.memory, self.memory.turn_commit("event-1", {"id": "e1", "text": "worker event"}, {"id": "a2", "text": "handled"}, scope=SCOPE), model)
        self.assertEqual(done["receipt"]["intent"]["status"], "inherited")
        self.assertIn("Worker result", self.memory.memory_read(SCOPE, self.topic("Topic")["id"])["statements"][-1]["text"])

    def test_forget_scope_removes_contributions(self):
        model = Script(intent=[{"focus": ["new:1"], "new": [{"key": "new:1", "label": "Topic"}]}],
                       extract=[{"statements": [{"topic": "T1", "text": "Secret fact", "status": "verified"}]}])
        self.turn(1, "start", "ok", model)
        topic = self.topic("Topic")["id"]
        self.memory.forget_scope(SCOPE)
        self.assertEqual(self.engine.pieces(SCOPE, "topic"), [])
        self.assertTrue(self.memory.memory_read(SCOPE, topic)["evicted"])

    def test_stdio_protocol_runs_policy_steps(self):
        self.engine.close()
        process = subprocess.Popen([sys.executable, "-m", "pkm_memory_engine", "--database", str(self.path), "--identity", "root|account"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
        def call(method, params, request_id):
            process.stdin.write(json.dumps({"protocol": 1, "id": request_id, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            return json.loads(process.stdout.readline())
        try:
            step = call("turn_begin", {"scope": SCOPE, "turn": "t1", "input": {"id": "u1", "text": "你好"}}, 1)["result"]
            self.assertEqual(step["request"]["purpose"], "intent")
            ready = call("turn_continue", {"turn": "t1", "output": json.dumps({"focus": ["new:1"], "new": [{"key": "new:1", "label": "问候"}]})}, 2)["result"]
            self.assertEqual(ready["status"], "ready")
            self.assertEqual(call("overview", {"scope": SCOPE}, 3)["result"]["topics"][0]["label"], "问候")
            self.assertFalse(call("turn_continue", {"turn": "t1", "output": "{}"}, 4)["ok"])
        finally:
            process.stdin.close()
            process.wait(10)
            process.stdout.close()
        self.engine = Engine(self.path, "root|account")


class SimulatorTest(unittest.TestCase):
    def test_scenario_replay_with_command_model(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, str(root / "tools" / "simulate.py"), str(root / "tests" / "scenarios" / "reference_followup.json"),
                                 "--command", f'"{sys.executable}" "{root / "tests" / "fake_model.py"}"'],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        turns = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"turn"')]
        self.assertEqual(turns[2]["intent"]["focus"], turns[0]["intent"]["focus"])


if __name__ == "__main__":
    unittest.main()
