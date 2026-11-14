"""Prepare a Skills-only imported-solution generation without changing its vector space."""

import os
import sys
import tempfile
from copy import copy


def prepare_scoped_solution(solution, packages, documents, publication_lock):
    from adaptive_skill_retrieval.architecture_retriever import _document_text, _quantize, _sections
    from adaptive_skill_retrieval.solution_package import load_installed
    from retrieval_solution_index import EmbeddingCache, cache_key, index_statistics, persist_index, rebuild_lexical

    identity = solution.release_id
    try:
        manifest = load_installed(packages, identity)
    except (OSError, ValueError, KeyError) as error:
        raise ValueError(f"need-full-reindex: selected model package failed integrity verification: {error}") from error
    if manifest["architecture"] != solution.architecture_id:
        raise ValueError("need-full-reindex: selected model architecture changed")
    old = solution.retriever
    encoder = old._encoder
    dimensions = getattr(encoder, "dimensions", 0)
    if not isinstance(dimensions, int) or dimensions <= 0:
        raise ValueError("need-full-reindex: model dimensions are unavailable")
    operators = set(old.architecture.operators)
    if not operators.intersection({"dense_encoder", "dense_document", "dense_section", "token_encoder"}):
        raise ValueError("need-full-reindex: unsupported semantic architecture")
    old_documents = old._documents
    if (len(old_documents) != len(old._document_vectors)
            or len({document.version for document in old_documents}) != len(old_documents)):
        raise ValueError("need-full-reindex: invalid existing semantic index")
    token_mode = "token_encoder" in operators
    if ((token_mode and len(old._token_vectors) != len(old._units))
            or (not token_mode and len(old._unit_vectors) != len(old._units))):
        raise ValueError("need-full-reindex: invalid existing semantic units")
    projected_dimensions = old._pca.components_.shape[0] if old._pca is not None else dimensions
    if old._pca is not None and old._pca.components_.shape[1] != dimensions:
        raise ValueError("need-full-reindex: model and projection dimensions differ")
    if any(len(vector) != projected_dimensions for vector in old._document_vectors):
        raise ValueError("need-full-reindex: existing document vector dimensions differ")
    existing_vectors = (vector for units in old._token_vectors for vector in units) if token_mode else iter(old._unit_vectors)
    if any(len(vector) != (dimensions if token_mode else projected_dimensions) for vector in existing_vectors):
        raise ValueError("need-full-reindex: existing unit vector dimensions differ")

    ordered = sorted(documents, key=lambda document: str(document.version))
    if len({document.version for document in ordered}) != len(ordered):
        raise ValueError("need-full-reindex: duplicate semantic document versions")
    old_by_version = {document.version: index for index, document in enumerate(old_documents)}
    new_versions = {document.version for document in ordered}
    for document in old_documents:
        if document.version not in new_versions and not (
                document.version.skill_id.startswith("skill:") and document.content_type.value == "skill"):
            raise ValueError("Scoped Skills update attempted to remove a non-Skill vector")
    for document in ordered:
        if document.version not in old_by_version and not (
                document.version.skill_id.startswith("skill:") and document.content_type.value == "skill"):
            raise ValueError("Scoped Skills update attempted to replace a non-Skill vector")

    units_by_document = [[] for _ in old_documents]
    for unit_index, (document_index, text) in enumerate(old._units):
        if not 0 <= document_index < len(old_documents):
            raise ValueError("need-full-reindex: invalid semantic unit source")
        units_by_document[document_index].append((unit_index, text))

    index_directory = packages.parent / "solution-indexes" / identity
    cache = EmbeddingCache(index_directory / (cache_key(identity, []) + ".embeddings.sqlite3"), dimensions)
    candidate = copy(solution)
    retriever = copy(old)
    candidate.retriever = retriever
    candidate.documents = ordered
    retriever._documents = ordered
    retriever._document_vectors = []
    retriever._units = []
    retriever._unit_vectors = []
    retriever._token_vectors = []

    def encode(texts, kind):
        if not texts:
            return []
        method = encoder.encode_tokens if kind == "tokens" else encoder.encode_documents
        values = cache.encode(texts, kind, method)
        if kind == "documents" and retriever._pca is not None:
            values = retriever._project(values)
        return values

    for document_index, document in enumerate(ordered):
        old_index = old_by_version.get(document.version)
        if old_index is not None:
            retriever._document_vectors.append(old._document_vectors[old_index])
            for unit_index, text in units_by_document[old_index]:
                retriever._units.append((document_index, text))
                if token_mode:
                    retriever._token_vectors.append(old._token_vectors[unit_index])
                else:
                    retriever._unit_vectors.append(old._unit_vectors[unit_index])
            continue
        document_text = _document_text(document)
        texts = _sections(document) if retriever.architecture.output_granularity == "markdown_section" else [document_text]
        retriever._document_vectors.extend(encode([document_text], "documents"))
        retriever._units.extend((document_index, text) for text in texts)
        if token_mode:
            vectors = encode(texts, "tokens")
            if "residual_compression" in operators:
                bits = int(retriever.config.get("compression_bits", 2))
                vectors = [[_quantize(vector, bits) for vector in row] for row in vectors]
            retriever._token_vectors.extend(vectors)
        else:
            retriever._unit_vectors.extend(encode(texts, "documents"))
    rebuild_lexical(retriever)
    target = index_directory / (cache_key(identity, ordered) + ".npz")
    index_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target == index_directory / (cache_key(identity, old_documents) + ".npz"):
        if not target.is_file():
            raise ValueError("need-full-reindex: existing semantic index is missing")
    else:
        with tempfile.TemporaryDirectory(prefix=".scoped-", dir=index_directory) as directory:
            staged = type(target)(directory) / target.name
            persist_index(retriever, staged, lambda: None, publication_lock)
            os.replace(staged, target)
            if os.name == "nt":
                print("Scoped solution index directory fsync is unavailable on Windows", file=sys.stderr, flush=True)
            else:
                descriptor = os.open(index_directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    candidate.index_reused = False
    candidate.index_path = target
    candidate.index_bytes = target.stat().st_size
    candidate.embedding_cache_bytes = cache.target.stat().st_size
    candidate.embedding_cache_hits = cache.hits
    candidate.embedding_cache_misses = cache.misses
    candidate.index_statistics = index_statistics(retriever)
    return candidate


def prune_scoped_solution(solution):
    target = solution.index_path
    for old in target.parent.glob("*.npz"):
        if old != target:
            old.unlink()
