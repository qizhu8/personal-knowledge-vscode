"""Local learning contracts and real HTTP worker admission, with no model download."""

import json
import os
from pathlib import Path
import shutil
import sqlite3
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
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)
        self.learning = RetrievalLearning(self.root)
        self.learning.salt = "deterministic-local-learning-fixture"
        with self.learning.connect() as connection:
            connection.execute("UPDATE settings SET value=? WHERE key='salt'", (self.learning.salt,))
        self.addCleanup(self.temp.cleanup)

    def observe(self, value=None):
        value = value if value is not None else result()
        self.learning.observe(value, 12.5)
        return value

    def train(self):
        for _ in range(8):
            value = self.observe()
            self.assertEqual(len(value["hits"]), 10)
            feedback = self.learning.feedback(value["retrieval_id"], ["source-0", "source-1"], True)
            self.assertTrue(feedback["trained"])
            self.assertEqual(feedback["judged_calls"], _ + 1)
            self.assertEqual(feedback["calibration_ready"], _ == 7)
            self.assertEqual(feedback["state"], "ready" if _ == 7 else "collecting-feedback")

    def test_defaults_feedback_gate_calibration_and_count(self):
        first = self.observe()
        self.assertEqual(first["adaptive"]["reason"], "insufficient-feedback")
        self.assertIsNone(self.learning.summary()["calls"][0]["recall"])
        initial = self.learning.summary()["models"][0]
        self.assertEqual(initial["state"], "collecting-feedback")
        self.assertFalse(initial["calibration_ready"])
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
        self.assertEqual(model["state"], "ready")
        self.assertTrue(model["calibration_ready"])
        feedback = self.learning.feedback(value["retrieval_id"], ["source-0", "source-9"], True)
        self.assertEqual(feedback["recall"], .5)
        self.assertEqual(len(self.observe()["hits"]), 10, "missed relevant result immediately closes the gate")
        self.assertFalse(self.learning.summary()["models"][0]["calibration_ready"])

    def test_precision_denominators_and_observed_policy_are_not_fabricated(self):
        value = result([1, .9, .8])
        self.learning.observe(value, 12.5, output_limit=2)
        summary = self.learning.summary()
        self.assertIsNone(summary["calls"][0]["precision"])
        self.assertEqual(summary["stored_calls"], 1)
        self.assertEqual(summary["stored_user_judgments"], 0)
        self.assertEqual(summary["policy"], {"minimum_gap": .15, "retain_probability": .65,
                         "discard_probability": .35, "threshold_ewma": .1, "retention_calls": 512})
        self.learning.feedback(value["retrieval_id"], ["source-0", "outside-pool"], True)
        call = self.learning.summary()["calls"][0]
        self.assertEqual(call["precision"], .5)
        self.assertEqual(call["recall"], .5)
        self.learning.feedback(value["retrieval_id"], [], True)
        call = self.learning.summary()["calls"][0]
        self.assertEqual(call["precision"], 0)
        self.assertIsNone(call["recall"])
        self.assertIsNone(RetrievalLearning.precision("[]", 0, "[]"))
        with self.learning.connect() as connection:
            self.assertNotIn("precision", {row[1] for row in connection.execute("PRAGMA table_info(calls)")},
                             "Precision is derived from existing bounded receipts, not a second label store")

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
        corrected = self.learning.feedback(receipt, ["source-9"], True)
        self.assertTrue(corrected["superseded"])
        self.assertEqual(corrected["version"], 2)
        self.learning.feedback(receipt, ["source-0", "source-1"], True)
        before = self.learning.summary()
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
        self.assertFalse(feedback["calibration_ready"])
        model = self.learning.summary()["models"][0]
        self.assertLess(model["current"]["bias"], model["baseline"]["bias"])
        self.assertEqual(model["safe_streak"], 0)

    def test_self_labels_train_ranker_calibrator_next_query_and_restart(self):
        baseline = self.observe(result([1, .95, .9]))
        self.assertFalse(baseline["online_learning"]["applied"])
        for _ in range(12):
            value = self.observe(result([1, .95, .9]))
            ack = self.learning.feedback(value["retrieval_id"], ["source-2"], True, "self")
            self.assertEqual(ack["provenance"], "model")
        trained = self.observe(result([1, .95, .9]))
        self.assertEqual(trained["hits"][0]["source_id"], "source-2")
        self.assertTrue(trained["online_learning"]["applied"])
        model = self.learning.summary()["models"][0]
        self.assertEqual(model["model_labels"], 12)
        self.assertEqual(model["user_labels"], 0)
        self.assertTrue(any(model["ranker"]["weights"]))
        self.assertNotEqual(model["current"], model["baseline"])
        self.assertEqual(model["prequential"]["evaluated_calls"], 12)
        self.assertGreaterEqual(model["prequential"]["brier"], 0)
        self.assertGreaterEqual(model["prequential"]["log_loss"], 0)
        self.assertTrue(all(abs(weight) <= 4 for weight in model["ranker"]["weights"]))
        restarted = RetrievalLearning(self.root)
        next_query = result([1, .95, .9])
        restarted.observe(next_query, 2)
        self.assertEqual(next_query["hits"], trained["hits"])
        self.assertEqual(next_query["online_learning"]["ranker_revision"], ack["ranker_revision"])
        self.assertFalse(next_query["online_learning"]["embedding_updated"])

    def test_no_feedback_preserves_exact_baseline_order_scores_and_count(self):
        baseline = result([18, 12, 3])
        original = list(baseline["hits"])
        for _ in range(3):
            value = self.observe(result([18, 12, 3]))
            self.assertEqual(value["hits"], original)
            self.assertFalse(value["online_learning"]["applied"])
            self.assertEqual(value["online_learning"]["revision"], 0)
        self.assertEqual(self.learning.summary()["models"][0]["judged_calls"], 0)

    def test_learned_rrf_semantics_preserve_raw_path_evidence_and_rank_full_pool(self):
        def pool():
            value = result([1 / (60 + rank) for rank in range(1, 11)], route="dual", score_semantics="rrf")
            for rank, hit in enumerate(value["hits"], 1):
                hit.update(rank=rank, score_semantics="rrf", path_evidence=[
                    {"path": "semantic", "rank": rank, "score": .5, "matched_field": "body",
                     "matched_path": "", "match": "semantic"}])
            return value
        original = pool()
        for _ in range(8):
            value = pool()
            self.learning.observe(value, 1, "query", 8)
            self.learning.feedback(value["retrieval_id"], ["source-9"], True, "model")
        value = pool()
        self.learning.observe(value, 1, "query", 8)
        self.assertEqual(len(value["hits"]), 8)
        self.assertEqual(value["hits"][0]["source_id"], "source-9")
        self.assertEqual(value["score_semantics"], "engine-defined")
        self.assertEqual(value["base_score_semantics"], "rrf")
        for rank, hit in enumerate(value["hits"], 1):
            baseline = next(item for item in original["hits"] if item["source_id"] == hit["source_id"])
            self.assertEqual(hit["rank"], rank)
            self.assertEqual(hit["score_semantics"], "engine-defined")
            self.assertEqual(hit["base_score_semantics"], "rrf")
            self.assertEqual(hit["base_score"], baseline["score"])
            self.assertEqual(hit["path_evidence"], baseline["path_evidence"])
            self.assertEqual(hit["score"], hit["learned_score"])

    def test_user_correction_replay_removes_stale_gradient_and_has_precedence(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as other:
            clean = RetrievalLearning(Path(other))
            # Identical private feature hashing lets us compare full parameters exactly.
            clean.salt = self.learning.salt
            receipts = []
            clean_receipts = []
            for _ in range(4):
                value = self.observe(result([1, .95, .9]))
                receipts.append(value["retrieval_id"])
                baseline = result([1, .95, .9])
                clean.observe(baseline, 12.5)
                clean_receipts.append(baseline["retrieval_id"])
            for receipt in receipts:
                self.learning.feedback(receipt, ["source-2"], True, "self")
            self.assertEqual(self.observe(result([1, .95, .9]))["hits"][0]["source_id"], "source-2")
            for receipt, clean_receipt in zip(receipts, clean_receipts):
                ack = self.learning.feedback(receipt, ["source-0"], True)
                self.assertTrue(ack["superseded"])
                self.assertEqual(ack["version"], 2)
                clean.feedback(clean_receipt, ["source-0"], True)
            actual = self.learning.summary()["models"][0]
            expected = clean.summary()["models"][0]
            for key in ("ranker", "current", "threshold", "safe_streak", "prequential"):
                self.assertEqual(actual[key], expected[key], key)
            self.assertEqual(actual["model_labels"], 0)
            self.assertEqual(actual["user_labels"], 4)
            self.assertEqual(self.observe(result([1, .95, .9]))["hits"][0]["source_id"], "source-0")
            before = self.learning.summary()
            ignored = self.learning.feedback(receipts[0], ["source-2"], True, "self")
            self.assertTrue(ignored["ignored"])
            self.assertEqual(ignored["reason"], "user-precedence")
            self.assertFalse(ignored["trained"])
            self.assertTrue(self.learning.feedback(receipts[0], ["source-0"], True)["duplicate"])
            self.assertEqual(self.learning.summary(), before)

    def test_query_features_privacy_scope_and_disabled_baseline(self):
        query = "private query sentinel"
        baseline = result([1, .95, .9])
        self.learning.observe(baseline, 1, query)
        for _ in range(5):
            value = result([1, .95, .9])
            self.learning.observe(value, 1, query)
            self.learning.feedback(value["retrieval_id"], ["source-2"], True, "self")
        value = result([1, .95, .9])
        self.learning.observe(value, 1, query)
        self.assertEqual(value["hits"][0]["source_id"], "source-2")
        for changes in ({"corpus_revision": "new"}, {"route": "dual"},
                        {"skill_serving": {"release_id": "new"}}):
            other = result([1, .95, .9], **changes)
            original = list(other["hits"])
            self.learning.observe(other, 1, query)
            self.assertEqual(other["hits"], original)
            self.assertFalse(other["online_learning"]["applied"])
        self.learning.configure(False)
        disabled = result([1, .95, .9])
        original = list(disabled["hits"])
        self.learning.observe(disabled, 1, query)
        self.assertEqual(disabled["hits"], original)
        self.assertFalse(disabled["online_learning"]["applied"])
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.learning.feedback(disabled["retrieval_id"], ["source-2"], True, "self")
        self.learning = RetrievalLearning(self.root)
        self.assertFalse(self.learning.summary()["enabled"])
        self.learning.configure(True)
        with self.learning.connect() as connection:
            serialized = json.dumps(connection.execute("SELECT candidates,labels,query_features FROM calls").fetchall())
        for private in (query, "sentinel", "source-2"):
            self.assertNotIn(private, serialized)
            self.assertNotIn(private.encode(), self.learning.database.read_bytes())

    def test_cross_receipt_user_authority_replays_only_latest_user_and_survives_restart(self):
        private_query = "Private   Query Sentinel"
        def observe(learner, query=private_query, **changes):
            value = result([1, .95, .9], **changes)
            learner.observe(value, 1, query)
            return value["retrieval_id"]
        def parameters(learner):
            model = next(item for item in learner.summary()["models"] if item["corpus_revision"] == "corpus-one")
            return {key: model[key] for key in ("current", "ranker", "threshold", "safe_streak",
                                               "prequential", "model_labels", "user_labels", "judged_calls")}
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as other:
            clean = RetrievalLearning(Path(other))
            clean.salt = self.learning.salt
            first = observe(self.learning)
            self.learning.feedback(first, ["source-2"], True, "model")
            second = observe(self.learning, " private query sentinel ")
            self.learning.feedback(second, ["source-2"], True, "model")
            user_receipt = observe(self.learning)
            ack = self.learning.feedback(user_receipt, ["source-0"], True)
            self.assertTrue(ack["superseded"])
            clean_receipt = observe(clean)
            clean.feedback(clean_receipt, ["source-0"], True)
            self.assertEqual(parameters(self.learning), parameters(clean))
            audit = self.learning.summary()["calls"]
            self.assertEqual([item["provenance"] for item in audit], ["model", "model", "user"])
            self.assertEqual([item["training_effective"] for item in audit], [False, False, True])
            self.learning = RetrievalLearning(self.root)
            later = observe(self.learning)
            before = parameters(self.learning)
            ignored = self.learning.feedback(later, ["source-2"], True, "model")
            self.assertTrue(ignored["ignored"])
            self.assertFalse(ignored["trained"])
            self.assertEqual(ignored["reason"], "user-precedence")
            self.assertGreater(ignored["ranker_revision"], 0)
            self.assertEqual(ignored["ranker_revision"], ack["ranker_revision"])
            self.assertEqual(parameters(self.learning), before)
            correction = self.learning.feedback(later, ["source-1"], True)
            self.assertTrue(correction["superseded"])
            clean.feedback(clean_receipt, ["source-1"], True)
            self.assertEqual(parameters(self.learning), parameters(clean))
            # Reasserting an older receipt is a new human correction, not a stale duplicate.
            reasserted = self.learning.feedback(user_receipt, ["source-0"], True)
            self.assertTrue(reasserted["trained"])
            clean.feedback(clean_receipt, ["source-0"], True)
            self.assertEqual(parameters(self.learning), parameters(clean))
            different = observe(self.learning, "different query")
            self.assertTrue(self.learning.feedback(different, ["source-2"], True, "model")["trained"])
            for changes in ({"corpus_revision": "new"}, {"route": "dual"},
                            {"skill_serving": {"release_id": "new"}}):
                scoped = observe(self.learning, **changes)
                self.assertTrue(self.learning.feedback(scoped, ["source-2"], True, "model")["trained"])
            with self.learning.connect() as connection:
                persisted = json.dumps(connection.execute("SELECT * FROM query_judgments").fetchall())
            for private in (private_query, "private query sentinel", "source-0", "source-1", "source-2"):
                self.assertNotIn(private, persisted)
                self.assertNotIn(private.encode(), self.learning.database.read_bytes())

    def test_query_authority_survives_receipt_retention_but_legacy_query_is_not_invented(self):
        self.learning.RETENTION = 2
        receipt = result([1, .95, .9])
        self.learning.observe(receipt, 1, "persistent query")
        self.learning.feedback(receipt["retrieval_id"], ["source-1"], True)
        for _ in range(3):
            value = result([1, .95, .9])
            self.learning.observe(value, 1, "persistent query")
        self.learning = RetrievalLearning(self.root)
        ignored = self.learning.feedback(value["retrieval_id"], ["source-2"], True, "model")
        self.assertTrue(ignored["ignored"])
        self.assertEqual(ignored["user_labels"], 1)
        legacy = self.observe(result([1, .95, .9]))
        self.learning.feedback(legacy["retrieval_id"], ["source-0"], True)
        another = self.observe(result([1, .95, .9]))
        self.assertTrue(self.learning.feedback(another["retrieval_id"], ["source-2"], True, "model")["trained"])
        with self.learning.connect() as connection:
            self.assertIsNone(connection.execute("SELECT query_key FROM calls WHERE receipt=?",
                                                (legacy["retrieval_id"],)).fetchone()[0])

    def test_prequential_measurement_precedes_update_and_correction_replaces_label(self):
        value = self.observe(result([1, .5]))
        expected = ((1 - self.learning.probability(1, 4, -2)) ** 2 +
                    self.learning.probability(.5, 4, -2) ** 2) / 2
        self.learning.feedback(value["retrieval_id"], ["source-0"], True, "self")
        self.assertAlmostEqual(self.learning.summary()["models"][0]["prequential"]["brier"], expected)
        ack = self.learning.feedback(value["retrieval_id"], ["source-1"], True)
        self.assertEqual(ack["judged_calls"], 1)
        self.assertEqual(ack["user_labels"], 1)
        self.assertEqual(ack["model_labels"], 0)
        expected = (self.learning.probability(1, 4, -2) ** 2 +
                    (1 - self.learning.probability(.5, 4, -2)) ** 2) / 2
        self.assertAlmostEqual(self.learning.summary()["models"][0]["prequential"]["brier"], expected)

    def test_calibrator_input_is_current_reranked_score_and_embeddings_are_frozen(self):
        embedding = self.root / "embedding.safetensors"
        embedding.write_bytes(b"frozen model fixture")
        original = embedding.read_bytes()
        first = self.observe(result([1, .95, .9]))
        self.learning.feedback(first["retrieval_id"], ["source-2"], True, "model")
        model = self.learning.summary()["models"][0]
        second = self.observe(result([1, .95, .9]))
        expected = sum((int(hit["source_id"] == "source-2") -
                        self.learning.probability(hit["score"], **{
                            "slope": model["current"]["slope"], "bias": model["current"]["bias"]})) ** 2
                       for hit in second["hits"]) / 3
        self.learning.feedback(second["retrieval_id"], ["source-2"], True, "model")
        self.assertAlmostEqual(self.learning.summary()["calls"][-1]["prequential_brier"], expected)
        self.assertEqual(embedding.read_bytes(), original)
        self.assertFalse(self.learning.summary()["embedding_updated"])

    def test_legacy_calibration_migration_discards_unreplayable_gradients(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as other:
            path = Path(other)
            with sqlite3.connect(path / "retrieval-learning.sqlite3") as connection:
                connection.executescript("""
                    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE models (context TEXT PRIMARY KEY, package TEXT, corpus TEXT, route TEXT,
                        slope REAL,bias REAL,threshold REAL,samples INTEGER,safe_streak INTEGER);
                    CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT,receipt TEXT UNIQUE,context TEXT,
                        milliseconds REAL,returned INTEGER,candidates TEXT,cut INTEGER,eligible INTEGER,
                        recall REAL,label_digest TEXT,success INTEGER);
                    INSERT INTO models VALUES ('context','package','corpus','semantic',8,3,.8,99,99);
                    INSERT INTO calls VALUES (1,'receipt','context',1,0,'[]',0,1,1,'legacy-digest',1);
                """)
            migrated = RetrievalLearning(path)
            model = migrated.summary()["models"][0]
            self.assertEqual(model["judged_calls"], 0)
            self.assertEqual(model["baseline"], model["current"])
            with migrated.connect() as connection:
                self.assertIsNone(connection.execute("SELECT label_digest FROM calls").fetchone()[0])

    def test_invalid_and_protected_inputs_never_train_or_rerank(self):
        cases = [result([.2, .8]), result([float("nan"), .1]), result([float("inf"), .1]),
                 result([1] * 257), result(exact_terms=["protected"]), result(semantic_status="fallback")]
        duplicate = result([1, .5])
        duplicate["hits"][1]["source_id"] = "source-0"
        cases.append(duplicate)
        malformed = result([1])
        malformed["hits"][0]["score"] = "invalid"
        cases.append(malformed)
        for metadata in ([1], {"priority": ["required"]}):
            malformed = result([1])
            malformed["hits"][0]["metadata"] = metadata
            cases.append(malformed)
        for value in cases:
            self.learning.observe(value, 1)
            self.assertFalse(value["online_learning"]["applied"])
            self.assertEqual(value["adaptive"]["reason"], "protected-or-unavailable")
            with self.assertRaisesRegex(ValueError, "not eligible"):
                self.learning.feedback(value["retrieval_id"], ["source-0"], True, "self")
        oversized_query = result()
        self.learning.observe(oversized_query, 1, "x" * 8193)
        self.assertFalse(oversized_query["online_learning"]["applied"])
        with self.assertRaises(ValueError):
            self.learning.feedback(oversized_query["retrieval_id"], [], True, "self")
        value = self.observe()
        for labels, provenance in [(["x" * 4097], "user"), (["x" * 4096] * 65, "self"),
                                   ([], "automated"), ([], None), ([], [])]:
            with self.assertRaises(ValueError):
                self.learning.feedback(value["retrieval_id"], labels, True, provenance)
        self.assertEqual(self.learning.summary()["models"][0]["judged_calls"], 0)

    def test_pruning_rebuilds_only_retained_labels(self):
        value = self.observe(result([1, .95, .9]))
        self.learning.feedback(value["retrieval_id"], ["source-2"], True, "self")
        for _ in range(512):
            self.observe(result([1, .95, .9]))
        model = self.learning.summary()["models"][0]
        self.assertEqual(model["judged_calls"], 0)
        self.assertFalse(any(model["ranker"]["weights"]))
        baseline = self.observe(result([1, .95, .9]))
        self.assertFalse(baseline["online_learning"]["applied"])
        self.assertEqual([hit["source_id"] for hit in baseline["hits"]], ["source-0", "source-1", "source-2"])


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
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
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
                    self.assertFalse(request("/retrieval-feedback", [])["ok"])
                    self.assertFalse(request("/retrieval-feedback", {"oversized": "x" * (1024 * 1024)})["ok"])
                    self.assertTrue(request("/retrieval-learning")["learning"]["enabled"])
                    query = {"query": "private query sentinel", "route": "semantic", "limit": 10}
                    receipts = []
                    for _ in range(8):
                        value = request("/search", query)
                        receipts.append(value["retrieval_id"])
                        self.assertEqual(len(value["hits"]), 10)
                        feedback = request("/retrieval-feedback", {"retrieval_id": value["retrieval_id"],
                            "relevant_source_ids": ["source-0", "source-1"], "complete": True, "provenance": "model"})
                        self.assertTrue(feedback["ok"] and feedback["trained"])
                        self.assertEqual(feedback["judged_calls"], _ + 1)
                        self.assertEqual(feedback["calibration_ready"], _ == 7)
                        self.assertEqual(feedback["state"], "ready" if _ == 7 else "collecting-feedback")
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
                    request("/retrieval-learning", {"enabled": True})
                    for receipt in receipts:
                        correction = request("/retrieval-feedback", {"retrieval_id": receipt,
                            "relevant_source_ids": ["source-9"], "complete": True, "provenance": "user"})
                        self.assertTrue(correction["superseded"])
                        self.assertEqual(correction["version"], 2)
                    reranked = request("/search", {**query, "output_limit": 8})
                    self.assertTrue(reranked["online_learning"]["applied"])
                    self.assertIn("source-9", [hit["source_id"] for hit in reranked["hits"]],
                                  "one effective user example must promote baseline #10 into delivered Top-8")
                    self.assertLessEqual(len(reranked["hits"]), 8)
                    self.assertEqual(reranked["hits"][0]["score_semantics"], "engine-defined")
                    cross_receipt = request("/retrieval-feedback", {"retrieval_id": reranked["retrieval_id"],
                        "relevant_source_ids": ["source-0"], "complete": True, "provenance": "model"})
                    self.assertTrue(cross_receipt["ignored"])
                    self.assertFalse(cross_receipt["trained"])
                    self.assertEqual(cross_receipt["reason"], "user-precedence")
                    self.assertEqual(cross_receipt["ranker_revision"], correction["ranker_revision"])
                    self.assertEqual(cross_receipt["calibrator_revision"], correction["calibrator_revision"])
                    self.assertEqual(cross_receipt["model_labels"], 0)
                    self.assertEqual(cross_receipt["user_labels"], 1)
                    precedence = request("/retrieval-feedback", {"retrieval_id": receipts[0],
                        "relevant_source_ids": ["source-0"], "complete": True, "provenance": "self"})
                    self.assertTrue(precedence["ignored"])
                    self.assertFalse(precedence["trained"])
                    self.assertFalse(request("/retrieval-feedback", {"retrieval_id": receipts[0],
                        "relevant_source_ids": [], "complete": True, "provenance": "invalid"})["ok"])
                    request("/retrieval-learning", {"enabled": False})
                    baseline = request("/search", query)
                    self.assertFalse(baseline["online_learning"]["applied"])
                    self.assertEqual(baseline["hits"][0]["source_id"], "source-0")
                    self.assertEqual(baseline["hits"][0]["score"], 1)
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
