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
from retrieval_solution_index import EmbeddingCache, cache_key, index_statistics, persist_index, restore_index, scoped_index
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
                        statistics = index_statistics(second)
                    self.assertEqual(statistics, index_statistics(first))
                    self.assertEqual(statistics["document_count"], 5)
                    self.assertEqual(statistics["document_vector_count"], 5)
                    self.assertEqual(statistics["unit_source_count"], 5)
                    self.assertEqual(statistics["unit_count"], 10 if second.architecture.output_granularity == "markdown_section" else 5)
                    if "token_encoder" in second.architecture.operators:
                        self.assertEqual(statistics["unit_vector_count"], 0)
                        self.assertGreater(statistics["token_vector_count"], statistics["unit_count"])
                    else:
                        self.assertEqual(statistics["unit_vector_count"], statistics["unit_count"])
                        self.assertEqual(statistics["token_vector_count"], 0)
                    self.assertEqual(first.search("Python testing", 5), second.search("Python testing", 5))
                    self.assertEqual(first._document_vectors, second._document_vectors)
                    self.assertEqual(first._token_vectors, second._token_vectors)
                    admitted = {self.documents[-1].version}
                    scoped = scoped_index(second, admitted)
                    self.assertEqual([hit.skill_version for hit in scoped.search("Python testing", 5)], list(admitted))
                    self.assertEqual(len(second._documents), 5, "Request scopes must not mutate shared index")
                    self.assertEqual(scoped_index(second, set()).search("Python", 5), [])
                    empty = index_statistics(scoped_index(second, set()))
                    for key in ("document_count", "document_vector_count", "unit_count", "unit_source_count",
                                "unit_vector_count", "token_vector_count"):
                        self.assertEqual(empty[key], 0, "an observed empty index is zero, unlike missing telemetry")

    def test_cache_identity_changes_with_corpus_and_package(self):
        self.assertNotEqual(cache_key("a", self.documents), cache_key("b", self.documents))
        self.assertNotEqual(cache_key("a", self.documents), cache_key("a", self.documents[:1]))

    def test_partial_embedding_batches_survive_cancellation_and_only_encode_changed_text(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "vectors.sqlite3"
            first = EmbeddingCache(target, 4)
            baseline = Encoder()
            self.assertEqual(first.encode(["a", "b", "a"], "documents", baseline.encode_documents),
                             baseline.encode_documents(["a", "b", "a"]))
            self.assertEqual(first.misses, 2)
            second = EmbeddingCache(target, 4)
            with patch.object(baseline, "encode_documents", wraps=baseline.encode_documents) as encode:
                result = second.encode(["b", "changed"], "documents", encode)
                self.assertEqual(encode.call_args.args[0], ["changed"])
            self.assertEqual(result, Encoder().encode_documents(["b", "changed"]))
            self.assertEqual(second.hits, 1)
            second.prune()
            with second.connect() as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM embeddings").fetchone()[0], 2)
            with second.connect() as connection:
                connection.execute("UPDATE embeddings SET digest='corrupt'")
            with self.assertRaisesRegex(ValueError, "integrity mismatch; use Rebuild"):
                second.encode(["b"], "documents", lambda _: self.fail("corrupt vectors must not be silently replaced"))

    def test_incremental_raw_cache_preserves_all_architectures_after_edits_and_deletions(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ARCHITECTURES:
                with self.subTest(architecture=name):
                    cache = EmbeddingCache(Path(directory) / (name + ".sqlite3"), 4)
                    baseline = Encoder()
                    class CachedEncoder:
                        dimensions = 4
                        encode_queries = baseline.encode_queries
                        def encode_documents(self, texts):
                            return cache.encode(texts, "documents", baseline.encode_documents)
                        def encode_tokens(self, texts):
                            return cache.encode(texts, "tokens", baseline.encode_tokens)
                    first = ArchitectureRetriever(architecture_by_id(name), self.config, encoder=CachedEncoder())
                    first.index(self.documents)
                    changed = self.documents[1:] + [SkillDocument.create(
                        skill_id="new", title="new topic", description="guide", body="# First\nNew Python")]
                    second = ArchitectureRetriever(architecture_by_id(name), self.config, encoder=CachedEncoder())
                    second.index(changed)
                    fresh = ArchitectureRetriever(architecture_by_id(name), self.config, encoder=Encoder())
                    fresh.index(changed)
                    self.assertGreater(cache.hits, 0)
                    self.assertEqual(second._document_vectors, fresh._document_vectors)
                    self.assertEqual(second._unit_vectors, fresh._unit_vectors)
                    self.assertEqual(second._token_vectors, fresh._token_vectors)
                    self.assertEqual(second.search("Python testing", 5), fresh.search("Python testing", 5))

    def test_factory_resumes_completed_batches_after_a_real_progress_cancellation(self):
        from retrieval_serving import ImportedSkillPath
        class LocalEncoder(Encoder):
            def __init__(self, *_args, **_kwargs):
                pass
        documents = [SkillDocument.create(skill_id=str(i), title=f"topic {i}", description="guide",
                                           body=f"# First\nPython {i}\n# Second\nTesting {i}") for i in range(32)]
        manifest = {"architecture": "dense-section", "parameters": {}, "validation": {}}
        def cancel(phase, current, _total):
            if phase == "encoding-documents-or-sections" and current == 16:
                raise RuntimeError("corpus changed")
        with tempfile.TemporaryDirectory() as directory, \
                patch("adaptive_skill_retrieval.solution_package.load_installed", return_value=manifest), \
                patch("adaptive_skill_retrieval.architecture_retriever.SentenceTransformerArchitectureEncoder", LocalEncoder):
            packages = Path(directory) / "solutions"
            with self.assertRaisesRegex(RuntimeError, "corpus changed"):
                ImportedSkillPath(packages, "fixture", documents, progress=cancel)
            self.assertEqual(list(Path(directory).rglob("*.npz")), [], "Cancelled generations cannot publish an index")
            changed = documents[1:] + [SkillDocument.create(skill_id="new", title="New topic", description="guide", body="New Python guide")]
            resumed = ImportedSkillPath(packages, "fixture", changed)
            self.assertGreaterEqual(resumed.embedding_cache_hits, 15)
            fresh = ArchitectureRetriever(architecture_by_id("dense-section"), {}, encoder=Encoder())
            fresh.index(resumed.documents)
            self.assertEqual(resumed.retriever._document_vectors, fresh._document_vectors)
            self.assertEqual(resumed.retriever._unit_vectors, fresh._unit_vectors)

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
