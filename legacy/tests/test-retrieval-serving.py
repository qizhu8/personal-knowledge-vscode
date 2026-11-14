import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from adaptive_skill_retrieval import RetrievalEngine, SkillDocument
from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
from adaptive_skill_retrieval.engine import Route
from adaptive_skill_retrieval.models import RouteState
from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id

spec = importlib.util.spec_from_file_location(
    "retrieval_serving", Path(__file__).resolve().parents[1] / "resources" / "retrieval_serving.py",
)
serving = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serving)


class Encoder:
    dimensions = 2

    def encode_documents(self, texts):
        return [(1., 0.) if "alpha" in text else (0., 1.) for text in texts]

    encode_queries = encode_documents


class TestFrozenSkillServing(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "release.json"
        self.source = [{
            "skill_id": "alpha", "title": "alpha", "description": "first",
            "body": "# intro\nalpha guide", "metadata": {"category": "Coding"},
        }, {
            "skill_id": "beta", "title": "beta", "description": "second",
            "body": "# intro\nbeta guide", "metadata": {"category": "Coding"},
        }]
        self.config = {
            "retrieval_architecture_id": "dense-section", "embedding_enabled": True,
            "model": "/local/model", "model_bundle_sha256": "test-model",
        }
        self.encoder_patch = patch(
            "adaptive_skill_retrieval.architecture_retriever.SentenceTransformerArchitectureEncoder",
            return_value=Encoder(),
        )
        self.encoder_patch.start()
        self.addCleanup(self.encoder_patch.stop)
        self.fingerprint_patch = patch(
            "adaptive_skill_retrieval.model_validation.local_model_bundle_fingerprint",
            return_value=(Path("/local/model"), "test-model"),
        )
        self.fingerprint_patch.start()
        self.addCleanup(self.fingerprint_patch.stop)
        retriever = ArchitectureRetriever(architecture_by_id("dense-section"), self.config)
        engine = RetrievalEngine([Route(identity=retriever.identity, retriever=retriever, state=RouteState.SERVING)])
        corpus = engine.index([SkillDocument.create(**value) for value in self.source])
        self.release = {
            "schema": "pkm.skill-serving/v1", "config": self.config,
            "documents": self.source, "weights": {retriever.identity.key: 1.},
            "validation": {"corpus_revision": corpus},
        }

    def write(self):
        self.path.write_text(json.dumps({
            "release": self.release, "sha256": serving.canonical_digest(self.release),
        }))

    def test_same_ranking_and_corpus_admission(self):
        self.write()
        path = serving.FrozenSkillPath(self.path)
        self.assertEqual([h.skill_version.skill_id for h in path.search("alpha help", 2)], ["alpha", "beta"])
        live = [{**value, "skill_id": "skill:" + value["skill_id"], "content_type": "skill"}
                for value in self.source]
        self.assertTrue(path.compatible(live))
        self.assertTrue(path.compatible(live + [{"skill_id": "note:extra", "content_type": "note"}]))
        self.assertFalse(path.compatible(live[:1]))
        live[0]["body"] = "changed"
        self.assertFalse(path.compatible(live))

    def test_corrupt_manifest_and_bundle(self):
        self.write()
        envelope = json.loads(self.path.read_text())
        envelope["release"]["config"]["model"] = "/changed"
        self.path.write_text(json.dumps(envelope))
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            serving.FrozenSkillPath(self.path)
        self.config["model_bundle_sha256"] = "changed"
        self.write()
        with self.assertRaisesRegex(ValueError, "bundle digest mismatch"):
            serving.FrozenSkillPath(self.path)

    def test_invalid_admission(self):
        for field, value, message in [
            ("schema", "unknown", "schema"),
            ("validation", {"corpus_revision": "changed"}, "corpus"),
            ("weights", {}, "weights"),
            ("config", {**self.config, "embedding_enabled": False}, "explicitly enable"),
            ("config", {**self.config, "retrieval_architecture_id": "graph-expanded-dense-document"}, "learned-link"),
        ]:
            with self.subTest(field=field, message=message):
                previous = self.release[field]
                self.release[field] = value
                self.write()
                with self.assertRaisesRegex(ValueError, message):
                    serving.FrozenSkillPath(self.path)
                self.release[field] = previous


if __name__ == "__main__":
    unittest.main()
