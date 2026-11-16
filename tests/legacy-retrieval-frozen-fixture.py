"""Random offline frozen release fixture; corpus integrity, not relevance acceptance."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1] / "legacy"
wheel = root / "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"
sys.path.insert(0, str(wheel))
from adaptive_skill_retrieval import RetrievalEngine, SkillDocument
from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
from adaptive_skill_retrieval.model_validation import local_model_bundle_fingerprint
from adaptive_skill_retrieval.engine import Route
from adaptive_skill_retrieval.models import RouteState

request = json.load(sys.stdin)
documents = [{"skill_id": value["skill_id"].removeprefix("skill:"), "title": value["title"],
              "description": value["description"], "body": value["body"]}
             for value in request["snapshot"]["documents"] if value["content_type"] == "skill"]
assert documents
path, digest = local_model_bundle_fingerprint(Path(request["root"]) / "model")
config = {"model": str(path), "model_bundle_sha256": digest, "embedding_enabled": True, "device": "cpu",
          "retrieval_architecture_id": "dense-section", "query_prompt": "", "document_prompt": ""}
retriever = ArchitectureRetriever(architecture_by_id("dense-section"), config)
engine = RetrievalEngine([Route(identity=retriever.identity, retriever=retriever, state=RouteState.SERVING)])
revision = engine.index([SkillDocument.create(**value) for value in documents])
release = {"schema": "pkm.skill-serving/v1", "config": config, "documents": documents,
           "validation": {"corpus_revision": revision}, "weights": {retriever.identity.key: 1.0}}
identity = hashlib.sha256(json.dumps(release, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
print(json.dumps({"release": release, "sha256": identity}, ensure_ascii=False))
