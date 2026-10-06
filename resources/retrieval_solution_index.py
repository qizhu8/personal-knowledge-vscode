"""Data-only local index persistence for the pinned ArchitectureRetriever."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
from contextlib import nullcontext
from importlib.metadata import PackageNotFoundError, version

FORMAT = "pkm-local-architecture-index-v1"

def rebuild_lexical(retriever):
    from adaptive_skill_retrieval.perspectives import RetrievalPerspective
    from adaptive_skill_retrieval.retrievers import BM25Retriever
    if "bm25" in retriever.architecture.operators:
        retriever._bm25 = BM25Retriever(
            retriever.identity,
            RetrievalPerspective(name="architecture-bm25", field_repetitions={"title": 1, "description": 1, "body": 1}),
            k1=float(retriever.config.get("bm25_k1", .9)), b=float(retriever.config.get("bm25_b", .4)),
        )
        retriever._bm25.index(retriever._documents)


def scoped_index(retriever, allowed_versions):
    """Apply admission before candidate truncation, without re-encoding text."""
    from copy import copy
    selected = [index for index, document in enumerate(retriever._documents) if document.version in allowed_versions]
    if len(selected) == len(retriever._documents):
        return retriever
    view = copy(retriever)
    remap = {old: new for new, old in enumerate(selected)}
    units = [index for index, (document, _) in enumerate(retriever._units) if document in remap]
    view._documents = [retriever._documents[index] for index in selected]
    view._document_vectors = [retriever._document_vectors[index] for index in selected]
    view._units = [(remap[retriever._units[index][0]], retriever._units[index][1]) for index in units]
    view._unit_vectors = [retriever._unit_vectors[index] for index in units] if retriever._unit_vectors else []
    view._token_vectors = [retriever._token_vectors[index] for index in units] if retriever._token_vectors else []
    rebuild_lexical(view)
    return view


def cache_key(identity, documents):
    from adaptive_skill_retrieval import architecture_retriever
    implementation = hashlib.sha256(Path(architecture_retriever.__file__).read_bytes() + Path(__file__).read_bytes()).hexdigest()
    runtime = {}
    for name in ("numpy", "scikit-learn", "sentence-transformers", "transformers", "torch"):
        try:
            runtime[name] = version(name)
        except PackageNotFoundError:
            runtime[name] = "not-installed"
    value = [FORMAT, identity, implementation, runtime,
             [str(document.version) for document in documents]]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def restore_index(retriever, documents, target):
    import numpy as np
    from adaptive_skill_retrieval.architecture_retriever import _document_text, _sections

    with np.load(target, allow_pickle=False) as saved:
        if str(saved["format"].item()) != FORMAT:
            raise ValueError("Unsupported local index format")
        if str(saved["key"].item()) != target.stem:
            raise ValueError("Local index identity mismatch")
        vectors = {}
        for name in ("document_vectors", "unit_vectors", "token_vectors"):
            array = saved[name]
            if array.ndim != 2 or not np.isfinite(array).all():
                raise ValueError(f"Invalid cached {name}")
            vectors[name] = [tuple(row) for row in array.tolist()]
        units = [(index, section) for index, document in enumerate(documents)
                 for section in (_sections(document) if retriever.architecture.output_granularity == "markdown_section"
                                 else [_document_text(document)])]
        if len(vectors["document_vectors"]) != len(documents):
            raise ValueError("Cached document count mismatch")
        token_mode = "token_encoder" in retriever.architecture.operators
        if not token_mode and len(vectors["unit_vectors"]) != len(units):
            raise ValueError("Cached unit count mismatch")
        offsets = saved["token_offsets"].tolist()
        if (not offsets or offsets[0] != 0 or offsets[-1] != len(vectors["token_vectors"])
                or any(not isinstance(value, int) for value in offsets)
                or offsets != sorted(offsets)
                or (token_mode and len(offsets) != len(units) + 1)):
            raise ValueError("Invalid cached token offsets")
        retriever._documents = list(documents)
        retriever._units = units
        retriever._document_vectors = vectors["document_vectors"]
        retriever._unit_vectors = vectors["unit_vectors"]
        retriever._token_vectors = [vectors["token_vectors"][a:b] for a, b in zip(offsets, offsets[1:])]
        if saved["pca_components"].size:
            from sklearn.decomposition import PCA
            components, mean = saved["pca_components"], saved["pca_mean"]
            if components.ndim != 2 or mean.shape != (components.shape[1],):
                raise ValueError("Invalid cached PCA shape")
            if not np.isfinite(components).all() or not np.isfinite(mean).all():
                raise ValueError("Non-finite cached PCA")
            pca = PCA(n_components=components.shape[0], svd_solver="full")
            pca.components_, pca.mean_ = components, mean
            pca.n_features_in_ = components.shape[1]
            pca.explained_variance_ = saved["pca_variance"]
            retriever._pca = pca
        rebuild_lexical(retriever)


def persist_index(retriever, target, check, publication_lock=None):
    import numpy as np
    flat, offsets = [], [0]
    for vectors in retriever._token_vectors:
        flat.extend(vectors)
        offsets.append(len(flat))
    def matrix(values):
        return np.asarray(values, dtype=np.float64) if values else np.empty((0, 0))
    pca = retriever._pca
    lock = publication_lock if publication_lock is not None else nullcontext()
    with lock:
        check()
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".index-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            np.savez(stream, format=FORMAT, key=target.stem,
                     document_vectors=matrix(retriever._document_vectors),
                     unit_vectors=matrix(retriever._unit_vectors),
                     token_vectors=matrix(flat), token_offsets=np.asarray(offsets, dtype=np.int64),
                     pca_components=pca.components_ if pca is not None else np.empty((0, 0)),
                     pca_mean=pca.mean_ if pca is not None else np.empty(0),
                     pca_variance=pca.explained_variance_ if pca is not None else np.empty(0))
            stream.flush()
            os.fsync(stream.fileno())
        with lock:
            check()
            os.replace(temporary, target)
            for old in target.parent.glob("*.npz"):
                if old != target:
                    old.unlink()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
