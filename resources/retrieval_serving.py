"""Explicit, immutable SI release admission for the Skill-only serving boundary."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def canonical_digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class FrozenSkillPath:
    def __init__(self, path: Path):
        from adaptive_skill_retrieval import RetrievalEngine, SkillDocument
        from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
        from adaptive_skill_retrieval.model_validation import local_model_bundle_fingerprint
        from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
        from adaptive_skill_retrieval.engine import Route
        from adaptive_skill_retrieval.models import RouteState

        envelope = json.loads(path.read_text())
        release = envelope["release"]
        if envelope["sha256"] != canonical_digest(release):
            raise ValueError("Serving release digest mismatch")
        if release["schema"] != "pkm.skill-serving/v1":
            raise ValueError("Unsupported serving release schema")
        self.release_id = envelope["sha256"]
        self.validation = release["validation"]
        config = release["config"]
        self.architecture_id = config["retrieval_architecture_id"]
        architecture = architecture_by_id(self.architecture_id)
        if "typed_graph_expansion" in architecture.operators:
            raise ValueError("Graph releases require a frozen learned-link artifact")
        if config.get("embedding_enabled") is not True:
            raise ValueError("Serving release must explicitly enable its local encoder")
        for key in ("model", "reranker_model"):
            if key == "reranker_model" and "cross_encoder_section" not in architecture.operators:
                continue
            _, digest = local_model_bundle_fingerprint(config[key])
            if digest != config[f"{key}_bundle_sha256"]:
                raise ValueError(f"Serving {key} bundle digest mismatch")
        self.source = release["documents"]
        self.documents = [SkillDocument.create(**value) for value in self.source]
        self.retriever = ArchitectureRetriever(architecture, config)
        engine = RetrievalEngine([Route(
            identity=self.retriever.identity, retriever=self.retriever, state=RouteState.SERVING,
        )])
        corpus_revision = engine.index(self.documents)
        if corpus_revision != self.validation["corpus_revision"]:
            raise ValueError("Serving corpus differs from the evaluated corpus")
        self.weights = release["weights"]
        if set(self.weights) != {self.retriever.identity.key}:
            raise ValueError("Serving route weights differ from the evaluated route")
        self.rank_constant = int(config.get("rank_constant", 60))

    def compatible(self, source_values: list[dict]) -> bool:
        live = {
            value["skill_id"].removeprefix("skill:"): value
            for value in source_values if value.get("content_type") == "skill"
        }
        if set(live) != {value["skill_id"] for value in self.source}:
            return False
        return all(
            (value["title"], value["description"], value["body"].strip())
            == (live[value["skill_id"]]["title"], live[value["skill_id"]]["description"],
                live[value["skill_id"]]["body"].strip())
            for value in self.source
        )

    def search(self, query: str, limit: int):
        from adaptive_skill_retrieval.measured_si_executor import weighted_reciprocal_rank_fusion

        key = self.retriever.identity.key
        return weighted_reciprocal_rank_fusion(
            {key: self.retriever.search(query, max(20, limit))},
            self.weights, limit=limit, rank_constant=self.rank_constant,
        )


class ImportedSkillPath:
    """Rebuild the imported algorithm over the Subscriber's typed text corpus."""

    def __init__(self, packages: Path, identity: str, documents, *, progress=None, publication_lock=None):
        from zipfile import BadZipFile
        from adaptive_skill_retrieval.solution_package import load_installed
        from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever, SentenceTransformerArchitectureEncoder
        from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
        from retrieval_solution_index import cache_key, persist_index, restore_index

        report = progress or (lambda *_args: None)
        report("verifying", 0, None)
        manifest = load_installed(packages, identity)
        self.release_id = identity
        self.architecture_id = manifest["architecture"]
        self.validation = manifest["validation"]
        self.documents = sorted(documents, key=lambda document: str(document.version))
        if not self.documents:
            raise ValueError("No local text documents to index")
        config = {
            **manifest["parameters"], "model": str(packages / identity / "model"),
            "device": "cpu", "embedding_enabled": True,
        }
        report("loading-model", 0, None)
        encoder = SentenceTransformerArchitectureEncoder(
            config["model"], device="cpu", query_prompt=config.get("query_prompt", ""),
            document_prompt=config.get("document_prompt", ""),
        )
        class ReportingEncoder:
            dimensions = encoder.dimensions

            def encode_queries(self, texts):
                return encoder.encode_queries(texts)

            def encode_documents(self, texts):
                return self.batches(texts, encoder.encode_documents, "encoding-documents-or-sections")

            def encode_tokens(self, texts):
                return self.batches(texts, encoder.encode_tokens, "encoding-tokens")

            def batches(self, texts, encode, phase):
                result = []
                for offset in range(0, len(texts), 16):
                    report(phase, offset, len(texts))
                    result.extend(encode(texts[offset:offset + 16]))
                report(phase, len(texts), len(texts))
                return result

        class ReportingRetriever(ArchitectureRetriever):
            def _fit_pca(self, vectors):
                report("fitting-pca", 0, None)
                return super()._fit_pca(vectors)

        self.retriever = ReportingRetriever(architecture_by_id(self.architecture_id), config, encoder=ReportingEncoder())
        target = packages.parent / "solution-indexes" / identity / (cache_key(identity, self.documents) + ".npz")
        self.index_reused = target.exists()
        report("restoring-index" if self.index_reused else "building-index", 0, None)
        if self.index_reused:
            try:
                restore_index(self.retriever, self.documents, target)
            except (OSError, ValueError, KeyError, EOFError, BadZipFile) as error:
                raise ValueError(f"Local index is corrupt/incompatible; use Rebuild to replace it: {error}") from error
        else:
            self.retriever.index(self.documents)
            report("persisting-index", 0, None)
            persist_index(self.retriever, target, lambda: report("persisting-index", 0, None), publication_lock)
        self.index_bytes = target.stat().st_size
        # Serving queries must not retain the build's cancellation/progress callback.
        self.retriever._encoder = encoder
        report("ready", len(self.documents), len(self.documents))

    def search(self, query: str, limit: int, allowed_versions=None):
        from retrieval_solution_index import scoped_index
        from adaptive_skill_retrieval.fusion import FusedHit
        retriever = self.retriever if allowed_versions is None else scoped_index(self.retriever, allowed_versions)
        return [FusedHit(hit.skill_version, hit.score, hit.rank, (self.retriever.identity.key,))
                for hit in retriever.search(query, 20)[:limit]]
