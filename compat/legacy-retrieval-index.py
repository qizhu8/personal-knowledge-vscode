import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time
from difflib import SequenceMatcher
from types import SimpleNamespace
from datetime import datetime, timezone
from contextlib import contextmanager

WHEEL = "adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"
WHEEL_SHA256 = "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89"
_cached_worker = None


def engine(snapshot, persistent=False, model=None):
    global _cached_worker
    wheel = Path(__file__).resolve().parents[1] / "legacy" / "resources" / "vendor" / WHEEL
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != WHEEL_SHA256:
        raise ValueError("NOT_AVAILABLE: Original lexical engine wheel changed.")
    sys.path.insert(0, str(wheel))
    from adaptive_skill_retrieval import (
        ContentType, RetrievalEngine, SkillDocument, academic_bm25_benchmark_route, exact_match_route,
    )
    if persistent and _cached_worker is not None:
        worker = _cached_worker
        if worker._native_model != model:
            worker = None
        if worker is not None:
            return update(worker, snapshot, persistent)
    spec = importlib.util.spec_from_file_location("original_retrieval_worker",
                                                 Path(__file__).with_name("legacy-retrieval-worker-captured.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    worker._native_model = model

    return initialize(worker, snapshot, persistent, model, ContentType, RetrievalEngine, SkillDocument,
                      academic_bm25_benchmark_route, exact_match_route)


def update(worker, snapshot, persistent):
    if worker._native_snapshot != snapshot:
        if worker.ready_generation != snapshot["generation"]:
            worker.ready_revision = ""
        worker.apply_delta({"deletes": [value["skill_id"] for value in worker._native_snapshot["documents"]],
                            "upserts": snapshot["documents"],
                            "corpus_revision": snapshot["corpus_revision"], "generation": snapshot["generation"]})
    if worker.ready_revision != snapshot["corpus_revision"] or worker.ready_generation != snapshot["generation"] or worker.last_error:
        raise ValueError("NOT_AVAILABLE: Persistent original corpus build failed: " + worker.last_error)
    if worker._native_model and not worker._native_model.get("frozenRelease") and worker.solutions.path is None:
        raise ValueError("NOT_AVAILABLE: Admitted local model rebuild failed: " + worker.solutions.error)
    if worker._native_model and worker._native_model.get("frozenRelease") and not worker.serving_ready:
        raise ValueError("NOT_AVAILABLE: Frozen release no longer matches the current native Skill corpus")
    return requests(worker, persistent)


def initialize(worker, snapshot, persistent, model, ContentType, RetrievalEngine, SkillDocument,
               academic_bm25_benchmark_route, exact_match_route):
    global _cached_worker

    class NoConfiguredProvider:
        def __truediv__(self, _name):
            return self

        def exists(self):
            return False

        def is_file(self):
            return False

    persisted = []

    def persist(_path, value):
        persisted[:] = [value]
        worker._native_snapshot = value

    class SnapshotBuffer:
        def exists(self):
            return bool(persisted)

        def read_text(self, encoding):
            return json.dumps(worker._native_snapshot, ensure_ascii=False)

    resources = Path(__file__).resolve().parents[1] / "legacy" / "resources"
    sys.path.insert(0, str(resources))
    from retrieval_solutions import SolutionManager
    import adaptive_skill_retrieval
    solutions = SolutionManager(NoConfiguredProvider(), persist)
    if model is not None and not model.get("frozenRelease"):
        model_spec = importlib.util.spec_from_file_location("native_model_admission",
                                                           Path(__file__).with_name("legacy-retrieval-model.py"))
        admission = importlib.util.module_from_spec(model_spec)
        model_spec.loader.exec_module(admission)
        manifest = admission.validate(model["root"], model["packageId"])
        if manifest != model["manifest"]:
            raise ValueError("Native model manifest differs from its immutable admission.")
        import retrieval_serving
        from adaptive_skill_retrieval.architecture_retriever import ArchitectureRetriever
        from adaptive_skill_retrieval.retrieval_architectures import architecture_by_id
        from adaptive_skill_retrieval.fusion import FusedHit
        class NativePackagePath:
            def __init__(self, _packages, identity, documents, *, progress=None, publication_lock=None):
                self.release_id = identity
                self.architecture_id = manifest["architecture"]
                self.validation = manifest["validation"]
                self.documents = sorted(documents, key=lambda document: str(document.version))
                config = {**manifest["parameters"], "model": str(Path(model["root"]) / "model"),
                          "device": "cpu", "embedding_enabled": True}
                self.retriever = ArchitectureRetriever(architecture_by_id(self.architecture_id), config)
                self.retriever.index(self.documents)

            def search(self, query, limit, allowed_versions=None):
                from retrieval_solution_index import scoped_index
                retriever = self.retriever if allowed_versions is None else scoped_index(self.retriever, allowed_versions)
                return [FusedHit(hit.skill_version, hit.score, hit.rank, (self.retriever.identity.key,))
                        for hit in retriever.search(query, 20)[:limit]]

        retrieval_serving.ImportedSkillPath = NativePackagePath
        solutions.managed = True
        solutions.requested = model["packageId"]
        build = solutions.build
        def native_build(documents, revision):
            build(documents, revision)
            if solutions.index:
                solutions.index["persistent"] = False
        solutions.build = native_build

    worker.__dict__.update({
        "ContentType": ContentType, "RetrievalEngine": RetrievalEngine, "SkillDocument": SkillDocument,
        "academic_bm25_benchmark_route": academic_bm25_benchmark_route, "exact_match_route": exact_match_route,
        "re": re, "math": math, "time": time, "sys": sys, "os": os, "datetime": datetime, "timezone": timezone,
        "SimpleNamespace": SimpleNamespace, "ENGINE_VERSION": "0.3.0.dev2026100504",
        "CONFIGURATION_HASH": "exact-bm25-fuzzy-dual-rrf-v1",
        "runtime_identity": {"python": sys.executable, "engine_version": "0.3.0.dev2026100504",
                             "engine_file": adaptive_skill_retrieval.__file__,
                             "cpu_threads": int(os.environ.get("OMP_NUM_THREADS", "1")),
                             "worker_build": (resources / "runtime-build").read_text() if (resources / "runtime-build").is_file() else "",
                             "worker_version": (resources / "runtime-version").read_text() if (resources / "runtime-version").is_file() else ""},
        "SequenceMatcher": SequenceMatcher, "engine_lock": threading.Lock(), "build_lock": threading.Lock(),
        "ready_engine": None, "ready_documents": {}, "ready_source_values": {}, "ready_forward": {},
        "ready_backlinks": {}, "ready_revision": "", "ready_generation": 0, "building_revision": "",
        "building_generation": 0, "frozen_skill_path": None, "serving_attempted": False, "serving_error": "",
        "serving_ready": False, "last_error": "", "state_dir": NoConfiguredProvider(), "snapshot_path": SnapshotBuffer(),
        "solutions": solutions, "atomic_json": persist,
        "work_state": "starting", "work_detail": "Starting retrieval worker", "work_current": 0, "work_total": 0,
        "work_updated_at": datetime.now(timezone.utc).isoformat(),
    })
    if model and model.get("frozenRelease"):
        class FrozenEnvelope:
            def __truediv__(self, name):
                return FrozenEnvelopeFile(name)
        class FrozenEnvelopeFile:
            def __init__(self, name):
                self.name = name
            def exists(self):
                return self.name == "serving-release.json"
            is_file = exists
            def read_text(self):
                if not self.exists():
                    raise ValueError("Unknown frozen model state artifact")
                return model["frozenRelease"]["envelopeJson"]
        worker.state_dir = FrozenEnvelope()
        with relocated_frozen_model(model):
            worker.build_snapshot_unlocked(snapshot)
    else:
        worker.build_snapshot_unlocked(snapshot)
    if worker.ready_engine is None or worker.ready_revision != snapshot["corpus_revision"] or persisted != [snapshot]:
        raise ValueError("NOT_AVAILABLE: Original lexical index build failed: " + worker.last_error)
    if model and not model.get("frozenRelease") and solutions.path is None:
        raise ValueError("NOT_AVAILABLE: Admitted local model failed to execute: " + solutions.error)
    if model and model.get("frozenRelease") and not worker.serving_ready:
        raise ValueError("NOT_AVAILABLE: Admitted frozen release failed: " + worker.serving_error)
    if persistent:
        _cached_worker = worker
    return requests(worker, persistent)


@contextmanager
def relocated_frozen_model(model):
    import adaptive_skill_retrieval.model_validation as validation
    import adaptive_skill_retrieval.architecture_retriever as architecture
    envelope = json.loads(model["frozenRelease"]["envelopeJson"])
    old_root = envelope["release"]["config"]["model"]
    new_root = str(Path(model["root"]) / "model")
    original_fingerprint = validation.local_model_bundle_fingerprint
    original_retriever = architecture.ArchitectureRetriever
    def fingerprint(path):
        if str(path) != old_root:
            raise ValueError("Frozen release references an unauthorized model path")
        return original_fingerprint(new_root)
    class RelocatedRetriever(original_retriever):
        def __init__(self, selected, config, **kwargs):
            if config.get("model") != old_root or selected.architecture_id != model["manifest"]["architecture"]:
                raise ValueError("Frozen release model/architecture differs from native admission")
            super().__init__(selected, {**config, "model": new_root, "device": "cpu"}, **kwargs)
    validation.local_model_bundle_fingerprint = fingerprint
    architecture.ArchitectureRetriever = RelocatedRetriever
    try:
        yield
    finally:
        validation.local_model_bundle_fingerprint = original_fingerprint
        architecture.ArchitectureRetriever = original_retriever


def requests(worker, persistent):
    def request(route, payload=None):
        if route == "/status":
            if not persistent:
                raise ValueError("NOT_AVAILABLE: Persistent status requires the owned live retrieval process.")
            return worker.status()
        if route == "/get":
            return worker.get_source(payload)
        if route == "/search":
            result = worker.search_unmeasured(payload)
            return result
        raise ValueError("NOT_AVAILABLE: Original model receipt/learning endpoints are not implemented.")

    return request
