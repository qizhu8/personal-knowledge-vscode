import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from adaptive_skill_retrieval.model_validation import local_model_bundle_fingerprint
from adaptive_skill_retrieval.solution_package import export_package, import_package

RESOURCES = Path(__file__).resolve().parents[1] / "resources"
sys.path.insert(0, str(RESOURCES))
from retrieval_solutions import SolutionManager, SolutionMetrics
from retrieval_serving import ImportedSkillPath


class TestSolutionLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "config.json").write_text("{}")
        (self.model / "modules.json").write_text('[{"idx":0,"name":"0","path":"","type":"sentence_transformers.models.Transformer"}]')
        (self.model / "model.safetensors").write_bytes(b"fixture")
        config = {"model": str(self.model), "model_bundle_sha256": local_model_bundle_fingerprint(self.model)[1],
                  "embedding_enabled": True, "retrieval_architecture_id": "dense-section"}
        self.archive = self.root / "solution.zip"
        export_package(self.archive, name="Fixture", config=config, validation={}, license="MIT")
        self.atomic = lambda path, value: path.write_text(json.dumps(value))
        self.manager = SolutionManager(self.root, self.atomic)
        self.identity = import_package(self.archive, self.manager.directory)["package_id"]

    def test_import_does_not_enable_and_lifecycle_persists(self):
        self.assertIsNone(self.manager.status()["requested_package_id"])
        self.assertEqual(len(self.manager.catalog()["packages"]), 1)
        self.manager.select(self.identity)
        restored = SolutionManager(self.root, self.atomic)
        self.assertEqual(restored.requested, self.identity)
        with patch("retrieval_serving.ImportedSkillPath", return_value=SimpleNamespace(release_id=self.identity)):
            self.manager.build([], "corpus-a")
        self.assertEqual(self.manager.status()["active_package_id"], self.identity)
        self.manager.select(None)
        self.assertIsNone(self.manager.capture()[2])
        self.assertTrue((self.manager.directory / self.identity).exists())
        self.manager.select(self.identity)
        self.manager.delete(self.identity)
        self.assertFalse((self.manager.directory / self.identity).exists())
        self.assertIsNone(SolutionManager(self.root, self.atomic).requested)
        self.assertTrue(self.model.exists(), "Deleting a package must not touch the source model")

    def test_disable_fences_inflight_build(self):
        entered, finish = threading.Event(), threading.Event()
        self.manager.select(self.identity)
        def load(*_args, **_kwargs):
            entered.set()
            self.assertTrue(finish.wait(5))
            return SimpleNamespace(release_id=self.identity)
        with patch("retrieval_serving.ImportedSkillPath", side_effect=load):
            thread = threading.Thread(target=self.manager.build, args=([], "corpus-a"))
            thread.start()
            self.assertTrue(entered.wait(5))
            self.manager.select(None)
            finish.set()
            thread.join(5)
        self.assertIsNone(self.manager.path)
        self.assertEqual(self.manager.status()["state"], "disabled")

    def test_unavailable_dependencies_and_invalid_selection_are_explicit(self):
        self.manager.select(self.identity)
        with patch("retrieval_serving.ImportedSkillPath", side_effect=ImportError("local encoder missing")):
            self.manager.build([], "corpus-a")
        self.assertEqual(self.manager.status()["state"], "blocked")
        self.assertIn("encoder missing", self.manager.error)
        with self.assertRaises(ValueError):
            self.manager.delete("../outside")
        with self.assertRaises(ValueError):
            self.manager.select("../outside")
        self.manager.selection.write_text("broken")
        self.assertIn("restore", SolutionManager(self.root, self.atomic).error)
        target = self.manager.directory / self.identity / "manifest.json"
        target.write_text("broken")
        self.assertIn("error", self.manager.catalog()["packages"][0])
        self.manager.delete(self.identity)
        self.assertEqual(self.manager.catalog()["packages"], [])

    def test_unchanged_text_reuses_index_and_any_content_change_rebuilds(self):
        self.manager.select(self.identity)
        first = SimpleNamespace(version="first", content_type=SimpleNamespace(value="skill"))
        other = SimpleNamespace(version="note", content_type=SimpleNamespace(value="note"))
        candidate = SimpleNamespace(release_id=self.identity, documents=[first])
        with patch("retrieval_serving.ImportedSkillPath", return_value=candidate) as load:
            self.manager.build([first], "corpus-a")
            self.manager.invalidate()
            self.manager.build([first], "corpus-b")
            self.assertEqual(load.call_count, 1)
            self.assertEqual(self.manager.corpus, "corpus-b")
            edited = SimpleNamespace(version="edited", content_type=first.content_type)
            self.manager.invalidate()
            self.manager.build([edited, other], "corpus-c")
            self.assertEqual(load.call_count, 2)
            self.manager.invalidate()
            self.manager.build([first, other], "corpus-d")
            self.assertEqual(load.call_count, 3)
        self.manager.select(None)
        self.assertIsNone(self.manager.cached_path)

    def test_metrics_persist_without_queries_and_keep_history_after_delete(self):
        metrics = SolutionMetrics(self.root)
        for index in range(270):
            metrics.record(requested=self.identity, served=self.identity, corpus="a" * 64,
                           entry="private query that must not persist", reason="served",
                           ok=index != 0, hits=5, milliseconds=index)
        row = metrics.summary()["buckets"][0]
        self.assertEqual(row["requests"], 270)
        self.assertEqual(row["latency_sample_count"], 256)
        self.assertEqual(row["p50_ms"], 141)
        self.assertEqual(row["p95_ms"], 257)
        self.assertEqual(row["errors"], 1)
        self.manager.delete(self.identity)
        summary = SolutionMetrics(self.root).summary()
        self.assertEqual(summary["buckets"][0]["requests"], 270)
        self.assertNotIn("private query", json.dumps(summary))
        self.assertFalse(summary["query_text_collected"])

    def test_imported_search_keeps_measured_candidate_depth(self):
        path = ImportedSkillPath.__new__(ImportedSkillPath)
        hits = [SimpleNamespace(skill_version=str(i), score=1.0, rank=i + 1) for i in range(20)]
        path.retriever = SimpleNamespace(identity=SimpleNamespace(key="dense"), search=Mock(return_value=hits))
        self.assertEqual(len(path.search("query", 2)), 2)
        self.assertEqual(len(path.search("query", 100)), 20)
        self.assertEqual([call.args for call in path.retriever.search.call_args_list],
                         [("query", 20), ("query", 20)])


if __name__ == "__main__":
    unittest.main()
