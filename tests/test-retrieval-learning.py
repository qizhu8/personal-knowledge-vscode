"""Local learning contracts and real HTTP worker admission, with no model download."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

RESOURCES = Path(__file__).resolve().parents[1] / "resources"
sys.path.insert(0, str(RESOURCES))
from retrieval_solutions import RetrievalLearning


def result(scores=None, **changes):
    scores = scores if scores is not None else [1, .95] + [.05 - i * .001 for i in range(8)]
    return {"ok": True, "model_invoked": True, "route": "semantic", "semantic_status": "ready",
            "corpus_revision": "corpus-one", "skill_serving": {"release_id": "model-one"},
            "hits": [{"source_id": f"source-{i}", "score": score, "metadata": {}} for i, score in enumerate(scores)],
            **changes}


class TestLearning(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.learning = RetrievalLearning(self.root)
        self.addCleanup(self.temp.cleanup)

    def observe(self, value=None):
        value = value if value is not None else result()
        self.learning.observe(value, 12.5)
        return value

    def train(self):
        for _ in range(8):
            value = self.observe()
            self.assertEqual(len(value["hits"]), 10)
            self.learning.feedback(value["retrieval_id"], ["source-0", "source-1"], True)

    def test_defaults_feedback_gate_calibration_and_count(self):
        first = self.observe()
        self.assertEqual(first["adaptive"]["reason"], "insufficient-feedback")
        self.assertIsNone(self.learning.summary()["calls"][0]["recall"])
        for complete, labels in [(False, ["source-0"]), (True, None), (1, ["source-0"])]:
            with self.assertRaises(ValueError):
                self.learning.feedback(first["retrieval_id"], labels, complete)
        self.train()
        value = self.observe()
        self.assertEqual(len(value["hits"]), 2)
        self.assertEqual(value["adaptive"]["reason"], "calibrated-score-gap")
        model = self.learning.summary()["models"][0]
        self.assertNotEqual(model["baseline"], model["current"])
        self.assertGreater(model["threshold"], .15)
        feedback = self.learning.feedback(value["retrieval_id"], ["source-0", "source-9"], True)
        self.assertEqual(feedback["recall"], .5)
        self.assertEqual(len(self.observe()["hits"]), 10, "missed relevant result immediately closes the gate")

    def test_no_cliff_scope_protection_disable_and_original_limit(self):
        self.train()
        for value in [result([1 - i * .01 for i in range(10)]), result(exact_terms=["protected"]),
                      result(semantic_status="fallback"), result(route="dual"), result(corpus_revision="new-corpus"),
                      result(skill_serving={"release_id": "different-model"})]:
            self.assertEqual(len(self.observe(value)["hits"]), 10)
        required = result()
        required["hits"][-1]["metadata"]["priority"] = "highest"
        self.assertEqual(len(self.observe(required)["hits"]), 10)
        self.learning.configure(False)
        self.assertEqual(len(self.observe()["hits"]), 10)
        self.assertEqual(len(self.observe(result([1, .95, .04, .03, .02]))["hits"]), 5)
        self.learning.configure(True)
        self.assertEqual(len(self.observe(result([1, .95, .04, .03, .02]))["hits"]), 2)
        with self.assertRaises(ValueError):
            self.learning.configure("false")

    def test_duplicate_feedback_restart_retention_and_privacy(self):
        self.train()
        value = self.observe()
        receipt = value["retrieval_id"]
        self.learning.feedback(receipt, ["source-0", "source-1"], True)
        before = self.learning.summary()
        self.assertTrue(self.learning.feedback(receipt, ["source-1", "source-0"], True)["duplicate"])
        self.assertEqual(self.learning.summary(), before)
        with self.assertRaises(ValueError):
            self.learning.feedback(receipt, ["source-9"], True)
        restarted = RetrievalLearning(self.root)
        self.assertEqual(restarted.summary(), before)
        self.assertEqual(len(self.observe()["hits"]), 2)
        raw = (self.root / "retrieval-learning.sqlite3").read_bytes()
        for private in (b"source-0", b"source-9", b"private query sentinel"):
            self.assertNotIn(private, raw)
        previous_id = before["calls"][-1]["invocation"]
        for index in range(520):
            self.observe(result(corpus_revision=f"revision-{index}"))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.learning.feedback(receipt, ["source-0"], True)
        summary = self.learning.summary()
        self.assertEqual(len(summary["calls"]), 256)
        self.assertGreater(summary["calls"][-1]["invocation"], previous_id + 512)
        with self.learning.connect() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM calls").fetchone()[0], 512)
            self.assertLessEqual(connection.execute("SELECT count(*) FROM models").fetchone()[0], 512)

    def test_offline_empty_and_failed_invocations(self):
        self.observe(result(model_invoked=False))
        self.assertEqual(self.learning.summary()["calls"], [])
        empty = self.observe(result([]))
        self.learning.feedback(empty["retrieval_id"], ["missed-source"], True)
        self.assertEqual(self.learning.summary()["calls"][-1]["recall"], 0)
        failure = self.observe(result(ok=False, semantic_status="unavailable"))
        with self.assertRaisesRegex(ValueError, "not eligible"):
            self.learning.feedback(failure["retrieval_id"], ["source-0"], True)
        self.assertIsNone(self.learning.summary()["calls"][-1]["recall"])

    def test_complete_all_negative_judgments_are_not_zero_recall(self):
        value = self.observe()
        feedback = self.learning.feedback(value["retrieval_id"], [], True)
        self.assertTrue(feedback["trained"])
        self.assertIsNone(feedback["recall"], "Recall is undefined if there are no relevant sources")
        model = self.learning.summary()["models"][0]
        self.assertLess(model["current"]["bias"], model["baseline"]["bias"])
        self.assertEqual(model["safe_streak"], 0)


FAKE_SERVING = """
from adaptive_skill_retrieval.fusion import FusedHit
from adaptive_skill_retrieval.models import SkillVersion
class FrozenSkillPath:
    release_id = 'model-one'
    architecture_id = 'fixture'
    validation = {}
    documents = list(range(10))
    def __init__(self, path): pass
    def compatible(self, values): return True
    def search(self, query, limit):
        if query == 'explode': raise RuntimeError('synthetic inference failure')
        scores = [1, .95] + [.05 - i * .001 for i in range(8)]
        if query == 'flat': scores = [1 - i * .01 for i in range(10)]
        return [FusedHit(SkillVersion('doc-' + str(i), 'frozen'), score, i + 1, ('fixture',))
                for i, score in enumerate(scores)]
"""


class TestWorkerLearning(unittest.TestCase):
    def test_http_scoped_serving_feedback_and_disable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("retrieval_worker.py", "retrieval_runtime.py", "retrieval_solutions.py", "retrieval_solution_resources.py"):
                shutil.copy2(RESOURCES / name, root)
            (root / "vendor").mkdir()
            shutil.copy2(RESOURCES / "vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl", root / "vendor")
            (root / "retrieval_serving.py").write_text(FAKE_SERVING)
            state = root / "state"
            state.mkdir()
            (state / "serving-release.json").write_text("{}")
            (state / "snapshot.json").write_text(json.dumps({
                "corpus_revision": "http-corpus", "documents": [
                    {"skill_id": "skill:doc-" + str(i), "source_id": "source-" + str(i),
                     "title": "doc-" + str(i), "body": "guidance", "content_type": "skill"}
                    for i in range(10)]}))
            with (root / "worker.log").open("w") as log:
                process = subprocess.Popen([sys.executable, str(root / "retrieval_worker.py"), str(state)], stdout=log, stderr=log)
                try:
                    self.wait(lambda: (state / "worker.json").exists() or process.poll() is not None)
                    self.assertIsNone(process.poll(), (root / "worker.log").read_text())
                    endpoint = json.loads((state / "worker.json").read_text())

                    def request(route, payload=None):
                        req = urllib.request.Request(f"http://127.0.0.1:{endpoint['port']}{route}",
                            data=None if payload is None else json.dumps(payload).encode(),
                            headers={"X-PKM-Retrieval-Token": endpoint["token"]})
                        try:
                            with urllib.request.urlopen(req, timeout=10) as response:
                                return json.load(response)
                        except urllib.error.HTTPError as error:
                            with error:
                                return json.load(error)

                    self.wait(lambda: request("/status")["skill_serving"]["ready"])
                    self.assertEqual(request("/retrieval-learning")["learning"]["calls"], [])
                    self.assertFalse(request("/retrieval-learning", {"enabled": "false"})["ok"])
                    self.assertTrue(request("/retrieval-learning")["learning"]["enabled"])
                    query = {"query": "private query sentinel", "route": "semantic", "limit": 10}
                    for _ in range(8):
                        value = request("/search", query)
                        self.assertEqual(len(value["hits"]), 10)
                        self.assertTrue(request("/retrieval-feedback", {"retrieval_id": value["retrieval_id"],
                            "relevant_source_ids": ["source-0", "source-1"], "complete": True})["ok"])
                    reduced = request("/search", query)
                    self.assertEqual(len(reduced["hits"]), 2)
                    self.assertEqual(reduced["adaptive"]["returned_count"], 2)
                    judged = request("/retrieval-feedback", {"retrieval_id": reduced["retrieval_id"],
                        "relevant_source_ids": ["source-0", "source-9"], "complete": True})
                    self.assertEqual(judged["recall"], .5)
                    flat = request("/search", {**query, "query": "flat"})
                    self.assertEqual(len(flat["hits"]), 10)
                    lexical = request("/search", {**query, "route": "lexical"})
                    self.assertNotIn("retrieval_id", lexical)
                    scoped = request("/search", {**query, "scope": {"source_ids": []}})
                    self.assertFalse(scoped["model_invoked"])
                    self.assertNotIn("retrieval_id", scoped)
                    limited = request("/search", {**query, "limit": 50, "output_limit": 5})
                    self.assertEqual(len(limited["hits"]), 5, "internal oversampling must not change the caller's delivered limit")
                    self.assertEqual(limited["adaptive"]["original_count"], 5)
                    failed = request("/search", {**query, "query": "explode", "route": "dual"})
                    self.assertTrue(failed["model_invoked"])
                    self.assertEqual(failed["semantic_status"], "fallback")
                    rejected = request("/retrieval-feedback", {"retrieval_id": failed["retrieval_id"],
                        "relevant_source_ids": ["source-0"], "complete": True})
                    self.assertFalse(rejected["ok"], "failed model attempts must not train on lexical fallback scores")
                    self.assertIn("not eligible", rejected["error"])
                    request("/retrieval-learning", {"enabled": False})
                    self.assertEqual(len(request("/search", query)["hits"]), 10)
                    catalog = request("/solutions")
                    self.assertFalse(catalog["learning"]["enabled"])
                    self.assertEqual(len(catalog["learning"]["calls"]), 13)
                    self.assertFalse(catalog["learning"]["calls"][-2]["success"])
                    output = os.environ.get("PKM_RETRIEVAL_LEARNING_FIXTURE")
                    if output:
                        request("/retrieval-learning", {"enabled": True})
                        catalog = request("/solutions")
                        Path(output).write_text(json.dumps({"catalog": catalog, "runtime": request("/status")}))
                    self.assertNotIn(b"private query sentinel", (state / "retrieval-learning.sqlite3").read_bytes())
                    request("/shutdown", {})
                    process.wait(timeout=10)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)
                    self.assertEqual(process.returncode, 0, (root / "worker.log").read_text())

    def wait(self, condition):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(.05)
        self.fail("worker did not become ready")


if __name__ == "__main__":
    unittest.main()
