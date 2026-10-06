import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from adaptive_skill_retrieval import SkillDocument
from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
from retrieval_solution_index import cache_key, persist_index, restore_index, scoped_index
from retrieval_solution_resources import process_sample, resource_plan

ARCHITECTURES = [
    "dense-document", "dense-section", "hierarchical-dense-section",
    "pca-dense-document", "pca-dense-section", "hierarchical-pca-dense-section",
    "hybrid-dense-lexical-document", "hybrid-pca-dense-lexical-document",
    "late-interaction-section", "compressed-late-interaction-section",
]


class Encoder:
    dimensions = 4

    def encode_documents(self, texts):
        return [tuple((value + 1) / 256 for value in hashlib.sha256(text.encode()).digest()[:4]) for text in texts]

    encode_queries = encode_documents

    def encode_tokens(self, texts):
        return [self.encode_documents(text.split()) for text in texts]


class TestPersistentIndex(unittest.TestCase):
    def setUp(self):
        self.documents = [SkillDocument.create(skill_id=str(i), title=f"topic {i}", description="guide",
                                              body=f"# First\nPython {i}\n# Second\nTesting {i}") for i in range(5)]
        self.config = {"retained_dimension_ratio": .5, "compression_bits": 2}

    def test_all_portable_architectures_restore_exact_rankings_without_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ARCHITECTURES:
                with self.subTest(architecture=name):
                    first = ArchitectureRetriever(architecture_by_id(name), self.config, encoder=Encoder())
                    first.index(self.documents)
                    target = Path(directory) / (name + ".npz")
                    persist_index(first, target, lambda: None)
                    second = ArchitectureRetriever(architecture_by_id(name), self.config, encoder=Encoder())
                    with patch.object(second._encoder, "encode_documents", side_effect=AssertionError("must reuse index")):
                        restore_index(second, self.documents, target)
                    self.assertEqual(first.search("Python testing", 5), second.search("Python testing", 5))
                    self.assertEqual(first._document_vectors, second._document_vectors)
                    self.assertEqual(first._token_vectors, second._token_vectors)
                    admitted = {self.documents[-1].version}
                    scoped = scoped_index(second, admitted)
                    self.assertEqual([hit.skill_version for hit in scoped.search("Python testing", 5)], list(admitted))
                    self.assertEqual(len(second._documents), 5, "Request scopes must not mutate shared index")
                    self.assertEqual(scoped_index(second, set()).search("Python", 5), [])

    def test_cache_identity_changes_with_corpus_and_package(self):
        self.assertNotEqual(cache_key("a", self.documents), cache_key("b", self.documents))
        self.assertNotEqual(cache_key("a", self.documents), cache_key("a", self.documents[:1]))

    def test_cancelled_publication_leaves_no_index_or_temporary_file(self):
        retriever = ArchitectureRetriever(architecture_by_id("dense-section"), self.config, encoder=Encoder())
        retriever.index(self.documents)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "index.npz"
            checks = []
            def cancel():
                checks.append(True)
                if len(checks) == 2:
                    raise RuntimeError("cancelled")
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                persist_index(retriever, target, cancel)
            self.assertEqual(len(checks), 2)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_persistence_io_failure_is_explicit_and_cleans_partial_files(self):
        retriever = ArchitectureRetriever(architecture_by_id("dense-section"), self.config, encoder=Encoder())
        retriever.index(self.documents)
        with tempfile.TemporaryDirectory() as directory:
            with patch("numpy.savez", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    persist_index(retriever, Path(directory) / "index.npz", lambda: None)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_corrupt_cache_and_wrong_document_count_fail_explicitly(self):
        retriever = ArchitectureRetriever(architecture_by_id("dense-section"), self.config, encoder=Encoder())
        retriever.index(self.documents)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "index.npz"
            persist_index(retriever, target, lambda: None)
            with self.assertRaisesRegex(ValueError, "count mismatch"):
                restore_index(retriever, self.documents[:1], target)
            target.write_bytes(b"not numpy")
            with self.assertRaises(ValueError):
                restore_index(retriever, self.documents, target)

    def test_resource_estimates_and_observations_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model").mkdir()
            (root / "model" / "config.json").write_text('{"hidden_size":4,"max_position_embeddings":128}')
            manifest = {"architecture": "dense-section", "files": {"model/model.safetensors": {"bytes": 1024}}}
            plan = resource_plan(root, manifest, self.documents)
            self.assertEqual(plan["document_count"], 5)
            self.assertEqual(plan["content_type_counts"], {"skill": 5})
            self.assertEqual(plan["unit_count"], 10)
            self.assertEqual(plan["index_bytes_estimate"], 15 * 4 * 8)
            self.assertGreater(plan["additional_disk_peak_bytes_estimate"], plan["index_bytes_estimate"])
            manifest["architecture"] = "late-interaction-section"
            self.assertEqual(resource_plan(root, manifest, self.documents)["index_bytes_estimate"], (5 + 10 * 128) * 4 * 8)
            sample = process_sample()
            self.assertIn("whole-worker-process", sample["scope"])
            if sys.platform == "linux":
                self.assertGreater(sample["rss_bytes"], 0)
                self.assertGreater(sample["logical_cpus"], 0)


if __name__ == "__main__":
    unittest.main()
