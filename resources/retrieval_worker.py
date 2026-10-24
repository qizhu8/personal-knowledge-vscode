#!/usr/bin/env python3
import json
import math
import re
from difflib import SequenceMatcher
from types import SimpleNamespace
import os
import secrets
import signal
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from retrieval_runtime import activate_engine

runtime_identity = activate_engine()
runtime_build_path = Path(__file__).resolve().parent / "runtime-build"
runtime_identity["worker_build"] = runtime_build_path.read_text() if runtime_build_path.is_file() else ""
runtime_version_path = Path(__file__).resolve().parent / "runtime-version"
runtime_identity["worker_version"] = runtime_version_path.read_text() if runtime_version_path.is_file() else ""

from adaptive_skill_retrieval import (
    ContentType,
    RetrievalEngine,
    SkillDocument,
    academic_bm25_benchmark_route,
    exact_match_route,
)

ENGINE_VERSION = "0.3.0.dev2026100504"
CONFIGURATION_HASH = sys.argv[2] if len(sys.argv) > 2 else "exact-bm25-fuzzy-dual-rrf-v1"
state_dir = Path(sys.argv[1]).resolve()
state_dir.mkdir(parents=True, exist_ok=True)
try: os.chmod(state_dir, 0o700)
except OSError: pass
lock_path = state_dir / "worker.lock"
endpoint_path = state_dir / "worker.json"
snapshot_path = state_dir / "snapshot.json"
token = secrets.token_urlsafe(32)
engine_lock = threading.Lock()
build_lock = threading.Lock()
ready_engine = None
ready_documents = {}
ready_source_values = {}
ready_forward = {}
ready_backlinks = {}
ready_revision = ""
building_revision = ""
ready_generation = 0
building_generation = 0
last_error = ""
work_state = "starting"
work_detail = "Starting retrieval worker"
work_current = 0
work_total = 0
work_updated_at = datetime.now(timezone.utc).isoformat()
frozen_skill_path = None
serving_attempted = False
serving_error = ""
serving_ready = False


def update_work(state, detail, current=0, total=0):
    global work_state, work_detail, work_current, work_total, work_updated_at
    work_state = str(state)
    work_detail = str(detail)
    work_current = int(current or 0)
    work_total = int(total or 0)
    work_updated_at = datetime.now(timezone.utc).isoformat()


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock():
    for _ in range(2):
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(fd, str(os.getpid()).encode("ascii"))
            os.close(fd)
            return True
        except FileExistsError:
            try:
                pid = int(lock_path.read_text(encoding="ascii").strip())
            except Exception:
                pid = 0
            if process_alive(pid):
                return False
            try:
                lock_path.unlink()
            except OSError:
                return False
    return False


def atomic_json(path, value):
    temp = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    try: os.chmod(temp, 0o600)
    except OSError: pass
    os.replace(temp, path)
    try:
        directory = os.open(str(path.parent), os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    except OSError: pass


def source_content_type(value):
    raw_type = str(value.get("content_type") or "skill")
    if raw_type == "subscription":
        upstream = str((value.get("metadata") or {}).get("upstream_type") or "")
        return {"skills": "skill", "notes": "note", "papers": "research", "research": "research", "scripts": "script"}.get(upstream, raw_type)
    return raw_type


def matches_content_types(value, requested):
    return (not requested or source_content_type(value) in requested
            or ("subscription" in requested and ((value.get("provenance") or {}).get("provider") == "broker"
                or str(value.get("source_uri") or "").startswith("pkm://subscriptions/"))))


def make_document(value):
    raw_type = source_content_type(value)
    try:
        content_type = ContentType(raw_type)
    except ValueError:
        content_type = ContentType("note")
    return SkillDocument.create(
        skill_id=str(value["skill_id"]),
        title=str(value.get("title") or ""),
        description=str(value.get("description") or ""),
        body=str(value.get("body") or ""),
        content_type=content_type,
        source_uri=str(value.get("source_uri") or ""),
        metadata={str(k): str(v) for k, v in (value.get("metadata") or {}).items()},
        provenance=dict(value.get("provenance") or {}),
        read_only=bool(value.get("read_only")),
    )


from retrieval_solutions import SolutionManager, SolutionMetrics, RetrievalLearning
solutions = SolutionManager(state_dir, atomic_json)
solution_metrics = SolutionMetrics(state_dir)
retrieval_learning = RetrievalLearning(state_dir)


def build_snapshot_unlocked(snapshot):
    global ready_engine, ready_documents, ready_source_values, ready_forward, ready_backlinks
    global ready_revision, building_revision, ready_generation, building_generation, last_error
    global frozen_skill_path, serving_attempted, serving_error, serving_ready
    revision = str(snapshot.get("corpus_revision") or "")
    generation = int(snapshot.get("generation") or (ready_generation + 1))
    if revision and revision == ready_revision:
        return
    building_revision = revision
    building_generation = generation
    try:
        source_values = list(snapshot.get("documents") or [])
        total = len(source_values)
        update_work("preparing", "Preparing retrieval documents", 0, total)
        documents = []
        for index, value in enumerate(source_values, 1):
            documents.append(make_document(value))
            if index == total or index % 25 == 0:
                update_work("preparing", "Preparing retrieval documents", index, total)
        engine = RetrievalEngine([exact_match_route(), academic_bm25_benchmark_route()])
        update_work("indexing", "Building Exact and BM25 indexes", total, total)
        engine.index(documents)
        by_version = {document.version: document for document in documents}
        values_by_version = {
            document.version: {**value, "content_type": source_content_type(value), "content_hash": document.version.content_hash}
            for document, value in zip(documents, source_values)
        }
        source_values = list(values_by_version.values())
        uri_to_id = {}
        for value in source_values:
            source_id = str(value.get("source_id") or value.get("skill_id") or "")
            uri_to_id[source_id] = source_id
            uri_to_id[str(value.get("source_uri") or "")] = source_id
        forward = {}
        backlinks = {}
        update_work("linking", "Building retrieval links", 0, total)
        for index, value in enumerate(source_values, 1):
            source_id = str(value.get("source_id") or value.get("skill_id") or "")
            for link in value.get("links") or []:
                target_uri = str(link.get("target") or "")
                target_id = uri_to_id.get(target_uri, target_uri)
                edge = {
                    "source_id": source_id, "target_id": target_id,
                    "relation": str(link.get("relation") or ""),
                    "mode": str(link.get("mode") or "floating"),
                    "target_revision": str(link.get("targetRevision") or ""),
                }
                forward.setdefault(source_id, []).append(edge)
                backlinks.setdefault(target_id, []).append(edge)
            if index == total or index % 25 == 0:
                update_work("linking", "Building retrieval links", index, total)
        update_work("persisting", "Persisting the retrieval snapshot", total, total)
        atomic_json(snapshot_path, snapshot)
        with engine_lock:
            solutions.invalidate()
            ready_engine = engine
            ready_documents = by_version
            ready_source_values = values_by_version
            ready_forward = forward
            ready_backlinks = backlinks
            ready_revision = revision
            ready_generation = generation
            last_error = ""
            serving_ready = frozen_skill_path is not None and frozen_skill_path.compatible(source_values)
        release_path = state_dir / "serving-release.json"
        if release_path.exists() and not serving_attempted and not solutions.managed:
            serving_attempted = True
            update_work("indexing", "Warming frozen Skill path; Exact/BM25 remains available", total, total)
            try:
                from retrieval_serving import FrozenSkillPath
                candidate = FrozenSkillPath(release_path)
                with engine_lock:
                    frozen_skill_path = candidate
                    serving_ready = candidate.compatible(source_values)
            except Exception as error:
                serving_error = f"Frozen Skill path unavailable: {type(error).__name__}: {error}"
                print(serving_error, file=sys.stderr, flush=True)
        if frozen_skill_path is not None:
            serving_error = "" if serving_ready else "Skill corpus changed; frozen path is not admitted for this generation"
        if solutions.managed:
            update_work("indexing", "Building imported solution on local Skills; BM25 remains available", total, total)
            solutions.build(documents, revision)
    except Exception as error:
        last_error = str(error)
    finally:
        building_revision = ""
        building_generation = 0
        update_work("idle", "Retrieval worker ready" if ready_engine is not None else "Retrieval build failed")


def build_snapshot(snapshot):
    with build_lock:
        build_snapshot_unlocked(snapshot)


def apply_delta(delta):
    with build_lock:
        try:
            current = json.loads(snapshot_path.read_text(encoding="utf-8")) if snapshot_path.exists() else {"documents": []}
        except Exception:
            current = {"documents": []}
        documents = {str(value.get("skill_id")): value for value in current.get("documents") or []}
        for skill_id in delta.get("deletes") or []:
            documents.pop(str(skill_id), None)
        for value in delta.get("upserts") or []:
            documents[str(value.get("skill_id"))] = value
        build_snapshot_unlocked({
            "corpus_revision": str(delta.get("corpus_revision") or ""),
            "generation": int(delta.get("generation") or 0),
            "documents": list(documents.values()),
        })


def status():
    edge_count = sum(len(edges) for edges in ready_forward.values())
    _, selected_package, imported_path, imported_error = solutions.capture()
    active_path = imported_path if solutions.managed else frozen_skill_path
    configured = bool(selected_package or imported_error) if solutions.managed else (state_dir / "serving-release.json").is_file()
    semantic_ready = imported_path is not None if solutions.managed else serving_ready
    return {
        "ok": True,
        "engine_version": ENGINE_VERSION,
        "runtime": runtime_identity,
        "configuration_hash": CONFIGURATION_HASH,
        "pid": os.getpid(),
        "corpus_revision": ready_revision,
        "building_revision": building_revision,
        "ready_generation": ready_generation,
        "building_generation": building_generation,
        "ready": ready_engine is not None,
        "document_count": len(ready_documents),
        "edge_count": edge_count,
        "schema": {
            "query": "pkm.retrieval.query/v1",
            "result": "pkm.retrieval.result/v1",
            "index_event": "pkm.retrieval.index-event/v1",
        },
        "engine": "adaptive_skill_retrieval",
        "solution": solutions.status(),
        "search_modes": ["lexical", "semantic", "dual"],
        "semantic_status": "off" if not configured else "ready" if semantic_ready else "unavailable",
        "skill_serving": {
            "enabled": bool(selected_package) if solutions.managed else serving_attempted,
            "ready": imported_path is not None if solutions.managed else serving_ready,
            "release_id": active_path.release_id if active_path else None,
            "architecture_id": active_path.architecture_id if active_path else None,
            "validation": active_path.validation if active_path else None,
            "fallback": "exact-bm25", "error": imported_error if solutions.managed else serving_error,
            "scope": "Explicit semantic/dual modes only; imported solutions use their indexed corpus, frozen releases cover Skills only",
        },
        "supported_routes": ["lexical", "semantic", "dual", "graph", "hybrid"],
        "unsupported_routes": [],
        "tokenizers": ["adaptive-skill-retrieval-academic-bm25"],
        "facets": ["content_type", "relation", "direction", "source_scope"],
        "update_mode": "persistent-delta-events-with-full-in-memory-rebuild",
        "limitations": [
            "The current Python engine rebuilds all in-memory lexical state for each accepted delta.",
            "Embedding retrieval requires an explicitly selected local solution or admitted frozen release; unconfigured means off.",
            "Results are L1 sources, not model-generated passage spans; raw path scores are evidence, dual ranking uses RRF(k=60).",
            "Cancellation is cooperative at request/deadline boundaries; an in-flight lexical call cannot be interrupted.",
        ],
        "error": last_error,
        "work_state": work_state,
        "work_detail": work_detail,
        "work_current": work_current,
        "work_total": work_total,
        "work_updated_at": work_updated_at,
    }


def get_source(payload):
    source_id = str(payload.get("source_id") or "").strip()
    if not source_id:
        return {"ok": False, "code": "invalid-id", "error": "source_id is required"}
    requested = payload.get("content_type_filter")
    if requested is not None and (not isinstance(requested, list) or not requested
                                  or any(value not in {"skill", "note", "research", "script", "recipe", "subscription"} for value in requested)):
        return {"ok": False, "code": "invalid-filter", "error": "Invalid content_type_filter"}
    with engine_lock:
        revision, generation = ready_revision, ready_generation
        sources = list(ready_source_values.values())
        building = building_revision
    if not revision:
        return {"ok": False, "code": "index-not-ready", "error": "Retrieval index is not ready"}
    for value in sources:
        canonical_id = str(value.get("source_id") or value.get("skill_id") or "")
        if source_id not in {canonical_id, str(value.get("source_uri") or ""), str(value.get("knowledge_id") or "")}:
            continue
        if str(value.get("visibility") or "available") != "available":
            break
        if not matches_content_types(value, requested):
            break
        scope = payload.get("scope") or {}
        if scope.get("source_ids") and canonical_id not in scope["source_ids"]:
            break
        if scope.get("include_read_only") is False and value.get("read_only"):
            break
        return {"schema": "pkm.knowledge.read/v1", "ok": True,
                "corpus_revision": revision, "ready_generation": generation, "stale": bool(building and building != revision),
                "source_id": canonical_id, "source_revision": str(value.get("source_revision") or value.get("content_hash") or ""),
                "content_type": value.get("content_type"), "content_hash": value.get("content_hash"),
                "source_uri": value.get("source_uri"), "title": value.get("title"), "description": value.get("description"),
                "content": value.get("body") or "", "metadata": dict(value.get("metadata") or {}),
                "provenance": dict(value.get("provenance") or {}), "read_only": bool(value.get("read_only"))}
    return {"ok": False, "code": "not-found", "error": "Knowledge source not found"}


def search(payload):
    started = time.perf_counter()
    epoch, requested_package, _, _ = solutions.capture()
    result = search_unmeasured(payload)
    if solutions.capture()[0] != epoch:
        result = {**{key: result.get(key) for key in ("model_invoked", "model_attempt_package_id", "corpus_revision", "route")},
                  "ok": False, "code": "solution-changed", "error": "Solution changed during this request; retry against the active path."}
    try:
        retrieval_learning.observe(result, round((time.perf_counter() - started) * 1000, 3))
    except sqlite3.Error as error:
        print(f"Retrieval learning persistence failed: {error}", file=sys.stderr, flush=True)
        result["learning_error"] = f"Adaptive result count unavailable; unmodified results returned: {error}"
    solution = result.get("solution", {})
    reason = solution.get("reason") or ("error" if not result.get("ok") else "default")
    try:
        solution_metrics.record(
            requested=requested_package,
            served=(solution.get("package_id") or (result.get("skill_serving") or {}).get("release_id") or "exact-bm25") if result.get("ok") else "none",
            corpus=result.get("corpus_revision", ready_revision),
            entry=(payload.get("scope") or {}).get("capability_id"),
            reason=reason, ok=bool(result.get("ok")), hits=len(result.get("hits", [])),
            milliseconds=round((time.perf_counter() - started) * 1000, 3),
        )
    except sqlite3.Error as error:
        print(f"Solution metrics persistence failed: {error}", file=sys.stderr, flush=True)
        result["metrics_error"] = str(error)
    return result


def lexical_match_evidence(query, value):
    """Bounded typo matching supplements Exact/BM25; never loads an encoder."""
    terms = re.findall(r"\w+", query.casefold())
    fields = [(key, str(value.get(key) or "")) for key in
              ("title", "description", "body", "source_uri", "skill_id")]
    for field, text in fields:
        if query.casefold() in text.casefold():
            return field, "exact"
    for field, text in fields:
        words = set(re.findall(r"\w+", text.casefold()))
        if terms and all(term in words for term in terms):
            return field, "keyword"
    for field, text in fields:
        words = set(re.findall(r"\w+", text.casefold()))
        if terms and all(term in words or (len(term) >= 4 and any(
                abs(len(term) - len(word)) <= 2 and SequenceMatcher(None, term, word).ratio() >= .8
                for word in words)) for term in terms):
            return field, "fuzzy"
    return "index", "keyword"


def dual_path_hits(query, mode, lexical_hits, documents, values, admitted, *, configured,
                   provider, provider_error="", imported=True):
    """Fuse ranks, not model scores; preserve each admitted path's original evidence.

    Configuration is checked before touching a provider, including its attributes.
    A semantic-only failure returns no lexical results; dual reports its fallback.
    """
    paths = {}
    if mode != "semantic":
        lexical = [hit for hit in lexical_hits if admitted(hit.skill_version)]
        seen = {hit.skill_version for hit in lexical}
        for version, value in values.items():
            if version not in seen and admitted(version) and lexical_match_evidence(query, value)[1] == "fuzzy":
                lexical.append(SimpleNamespace(skill_version=version, rank=max((hit.rank for hit in lexical), default=0) + 1, score=0.0))
        paths["lexical"] = lexical
    status = "off"
    reason = ""
    if mode in {"semantic", "dual"} and configured:
        status = "unavailable"
        try:
            if provider is None:
                raise ValueError(provider_error or "Configured embedding solution is not ready")
            allowed = {version for version in values if admitted(version)}
            raw = [] if not allowed else (provider.search(query, len(documents), allowed) if imported
                                         else provider.search(query, len(documents)))
            by_id = {version.skill_id: version for version in documents}
            semantic = []
            for hit in raw:
                version = hit.skill_version if imported else by_id.get("skill:" + hit.skill_version.skill_id)
                if (version not in values or type(hit.rank) is not int or hit.rank < 1
                        or isinstance(hit.score, bool) or not math.isfinite(hit.score)):
                    raise ValueError("retrieval model returned invalid hit identity, rank, or score")
                if admitted(version):
                    semantic.append(SimpleNamespace(skill_version=version, rank=hit.rank, score=hit.score))
            paths["semantic"] = semantic
            status = "ready"
        except Exception as error:
            reason = f"Embedding retrieval unavailable: {type(error).__name__}: {error}"
            status = "fallback" if mode == "dual" else "unavailable"
    fused = {}
    for path, hits in paths.items():
        seen = set()
        for hit in hits:
            version = hit.skill_version
            if version in seen:
                continue
            seen.add(version)
            field, match = lexical_match_evidence(query, values[version]) if path == "lexical" else ("embedding-index", "semantic")
            evidence = {"path": path, "rank": hit.rank, "score": float(hit.score),
                        "matched_field": field, "matched_path": values[version].get("source_uri", ""), "match": match}
            row = fused.setdefault(version, {"score": 0.0, "evidence": []})
            row["score"] += 1.0 / (60 + hit.rank) if mode == "dual" else float(hit.score)
            row["evidence"].append(evidence)
    result = []
    def ranking(item):
        row = item[1]
        return (-row["score"] if mode == "dual" else row["evidence"][0]["rank"], str(item[0]))

    for rank, (version, row) in enumerate(sorted(fused.items(), key=ranking), 1):
        sources = [entry["path"] for entry in row["evidence"]]
        result.append(SimpleNamespace(
            skill_version=version, rank=rank, score=row["score"], sources=sources,
            source_label="both" if len(sources) == 2 else "from keyword search" if sources == ["lexical"] else "from embedding retrieval",
            path_evidence=row["evidence"], contributing_routes=tuple(sources),
            score_components={"lexical": next((entry["score"] for entry in row["evidence"] if entry["path"] == "lexical"), 0.0),
                              "semantic": next((entry["score"] for entry in row["evidence"] if entry["path"] == "semantic"), 0.0),
                              "graph": 0.0, "priority": 1.0},
        ))
    return result, status, reason


def search_unmeasured(payload):
    search_started = time.perf_counter()
    with engine_lock:
        engine = ready_engine
        documents = ready_documents
        source_values = ready_source_values
        forward = ready_forward
        backlinks = ready_backlinks
        revision = ready_revision
        generation = ready_generation
        skill_path = frozen_skill_path if serving_ready else None
        _, requested_package, imported_path, package_error = solutions.capture()
        if solutions.managed:
            skill_path = imported_path
    if engine is None:
        return {"ok": False, "error": "Retrieval index is not ready.", "corpus_revision": revision}
    route = str(payload.get("route") or "lexical")
    if route not in {"lexical", "semantic", "dual", "graph", "hybrid"}:
        return {"ok": False, "error": "Unsupported retrieval route.", "code": "unsupported-route"}
    deadline_at_ms = int(payload.get("deadline_at_ms") or 0)
    if deadline_at_ms and int(time.time() * 1000) >= deadline_at_ms:
        return {"ok": False, "error": "Retrieval deadline exceeded.", "code": "deadline-exceeded"}
    policy = payload.get("generation") or {"mode": "latest-ready"}
    mode = str(policy.get("mode") or "latest-ready")
    requested_generation = int(policy.get("generation") or 0)
    if mode == "exact" and generation != requested_generation:
        return {"ok": False, "error": "Exact retrieval generation is not ready.", "code": "generation-not-ready",
                "ready_generation": generation}
    if mode == "minimum" and generation < requested_generation:
        return {"ok": False, "error": "Minimum retrieval generation is not ready.", "code": "generation-not-ready",
                "ready_generation": generation}
    requested = payload.get("content_type_filter")
    if requested is not None and (not isinstance(requested, list) or not requested
                                  or any(str(value) not in {"skill", "note", "research", "script", "recipe", "subscription"} for value in requested)):
        return {"ok": False, "code": "invalid-filter", "error": "Invalid content_type_filter"}
    engine_filter = []
    engine_types = set(requested or [])
    if "subscription" in engine_types:
        engine_types.update({"skill", "note", "research", "script"})
    for value in engine_types:
        try: engine_filter.append(ContentType(str(value)))
        except ValueError: engine_filter.append(ContentType("note"))
    content_filter = engine_filter if requested is not None else None
    result = engine.search(str(payload.get("query") or ""), limit=max(1, min(int(payload.get("limit") or 5), 100)), content_type_filter=content_filter)
    scope = payload.get("scope") or {}
    allowed_source_ids = None if scope.get("source_ids") is None else set(scope["source_ids"])
    strict_types = set(str(value) for value in requested or [])

    def admitted(version):
        value = source_values[version]
        return ((allowed_source_ids is None or str(value.get("source_id") or version.skill_id) in allowed_source_ids)
                and str(value.get("visibility") or "available") == "available"
                and not (scope.get("include_read_only") is False and value.get("read_only"))
                and matches_content_types(value, strict_types))

    configured = bool(requested_package or package_error) if solutions.managed else (state_dir / "serving-release.json").is_file()
    selected_hits, semantic_status, fallback_error = dual_path_hits(
        str(payload.get("query") or ""), route, result.hits, documents, source_values,
        admitted, configured=configured, provider=skill_path,
        provider_error=package_error if solutions.managed else serving_error,
        imported=solutions.managed,
    )
    serving_used = any("semantic" in hit.sources for hit in selected_hits)
    hits = []
    for hit in selected_hits:
        document = documents[hit.skill_version]
        source_value = source_values[hit.skill_version]
        source_id = str(source_value.get("source_id") or hit.skill_version.skill_id)
        if allowed_source_ids is not None and source_id not in allowed_source_ids:
            continue
        if str(source_value.get("visibility") or "available") != "available":
            continue
        if (payload.get("scope") or {}).get("include_read_only") is False and bool(source_value.get("read_only")):
            continue
        if not matches_content_types(source_value, strict_types):
            continue
        hits.append({
            "rank": hit.rank,
            "score": hit.score,
            "skill_id": hit.skill_version.skill_id,
            "content_hash": hit.skill_version.content_hash,
            "source_id": source_id,
            "source_revision": str(source_value.get("source_revision") or hit.skill_version.content_hash),
            "content_type": str(source_value.get("content_type") or document.content_type.value),
            "source_uri": document.source_uri,
            "title": document.title,
            "description": document.description,
            "metadata": dict(document.metadata),
            "provenance": dict(document.provenance),
            "read_only": document.read_only,
            "contributing_routes": list(hit.contributing_routes),
            "sources": hit.sources,
            "source_label": hit.source_label,
            "path_evidence": hit.path_evidence,
            "score_semantics": "rrf" if route == "dual" else "engine-defined",
            "score_components": hit.score_components,
        })
    diagnostics = []
    if fallback_error:
        diagnostics.append({"code": "skill-serving-fallback", "message": fallback_error})
    incomplete = semantic_status in {"unavailable", "fallback"}
    if route in {"graph", "hybrid"} and hits:
        graph = payload.get("graph") or {}
        max_depth = max(1, min(int(graph.get("max_depth") or 1), 32))
        max_nodes = max(1, min(int(graph.get("max_nodes") or 100), 10000))
        max_edges = max(1, min(int(graph.get("max_edges") or 500), 50000))
        relations = set(str(value) for value in graph.get("relations") or [])
        direction = str(graph.get("direction") or "both")
        by_source = {str(value.get("source_id") or value.get("skill_id") or ""): value for value in source_values.values()}
        hit_ids = {hit["source_id"] for hit in hits}
        queue = [(source_id, 0) for source_id in hit_ids]
        visited = set()
        traversed_edges = 0
        while queue:
            if deadline_at_ms and int(time.time() * 1000) >= deadline_at_ms:
                return {"ok": False, "error": "Retrieval deadline exceeded.", "code": "deadline-exceeded"}
            current, depth = queue.pop(0)
            if current in visited:
                diagnostics.append({"code": "cycle", "message": "Graph cycle was bounded.", "source_id": current})
                continue
            visited.add(current)
            if len(visited) >= max_nodes:
                incomplete = bool(queue)
                break
            if depth >= max_depth:
                continue
            candidates = ([] if direction == "backlink" else forward.get(current, [])) + ([] if direction == "forward" else backlinks.get(current, []))
            for edge in candidates:
                if relations and edge["relation"] not in relations:
                    continue
                next_id = edge["target_id"] if edge["source_id"] == current else edge["source_id"]
                target = by_source.get(next_id)
                if target is None:
                    diagnostics.append({"code": "unresolved-target", "message": "A canonical graph target is unresolved.",
                                        "source_id": current, "target_id": next_id, "relation": edge["relation"]})
                    continue
                if allowed_source_ids and next_id not in allowed_source_ids:
                    diagnostics.append({"code": "unavailable-target", "message": "A graph target is outside the caller capability scope.",
                                        "source_id": current, "relation": edge["relation"]})
                    continue
                if str(target.get("visibility") or "available") != "available":
                    diagnostics.append({"code": "unavailable-target", "message": "A graph target is unavailable.",
                                        "source_id": current, "relation": edge["relation"]})
                    continue
                if not matches_content_types(target, strict_types):
                    continue
                if (payload.get("scope") or {}).get("include_read_only") is False and target.get("read_only"):
                    continue
                if edge["mode"] == "pinned" and edge["target_revision"] != str(target.get("source_revision") or ""):
                    diagnostics.append({"code": "pinned-revision-mismatch", "message": "Pinned graph target revision is unavailable.",
                                        "source_id": current, "target_id": next_id, "relation": edge["relation"]})
                    continue
                traversed_edges += 1
                if traversed_edges >= max_edges:
                    incomplete = True
                    break
                if next_id not in visited:
                    queue.append((next_id, depth + 1))
                if next_id not in hit_ids:
                    hit_ids.add(next_id)
                    hits.append({
                        "rank": len(hits) + 1, "score": 0.0,
                        "skill_id": str(target.get("skill_id") or next_id),
                        "source_id": next_id,
                        "source_revision": str(target.get("source_revision") or ""),
                        "content_hash": str(target.get("content_hash") or ""),
                        "content_type": str(target.get("content_type") or "note"),
                        "source_uri": str(target.get("source_uri") or ""),
                        "title": str(target.get("title") or ""),
                        "description": str(target.get("description") or ""),
                        "metadata": dict(target.get("metadata") or {}),
                        "provenance": dict(target.get("provenance") or {}),
                        "read_only": bool(target.get("read_only")),
                        "contributing_routes": ["graph"],
                        "score_components": {"lexical": 0.0, "semantic": 0.0, "graph": 1.0, "priority": 1.0},
                    })
            if incomplete:
                break
        if incomplete:
            diagnostics.append({"code": "truncated", "message": "Graph traversal stopped at the configured budget."})
    result_limit = min(max(1, min(int(payload.get("limit") or 5), 100)),
                       max(1, min(int(payload.get("output_limit") or payload.get("limit") or 5), 100)))
    limit_reached = len(selected_hits) >= result_limit or (route != "semantic" and len(result.hits) >= result_limit)
    truncated = len(hits) > result_limit
    if limit_reached:
        diagnostics.append({"code": "candidate-limit-reached", "message": "Candidate limit reached; more matching sources may exist."})
    diagnostics_level = str(payload.get("diagnostics") or "summary")
    model_invoked = bool(configured and skill_path is not None and route in {"semantic", "dual"}
                         and any(admitted(version) for version in documents))
    return {
        "ok": True,
        "schema": "pkm.retrieval.result/v1",
        "request_id": str(payload.get("request_id") or ""),
        "corpus_revision": revision,
        "ready_generation": generation,
        "route": route,
        "search_mode": route if route in {"lexical", "semantic", "dual"} else "lexical",
        "semantic_status": semantic_status,
        "model_invoked": model_invoked,
        "model_attempt_package_id": skill_path.release_id if model_invoked else None,
        "semantic_reason": fallback_error or ("Embedding retrieval is not configured" if not configured else "Embedding path not requested" if route not in {"semantic", "dual"} else ""),
        "solution": {
            "package_id": requested_package if serving_used and solutions.managed else None,
            "reason": "served" if serving_used else "scope" if requested_package and result.query_intent.value != "semantic" else "unavailable" if requested_package and skill_path is None else "execution-error" if fallback_error else "default",
        },
        "skill_serving": {
            "used": serving_used,
            "release_id": skill_path.release_id if serving_used else None,
            "fallback_reason": fallback_error or None,
        },
        "query_intent": result.query_intent.value,
        "intent_signals": list(result.intent_signals),
        "exact_terms": list(result.exact_terms),
        "lexical_anchors": list(result.lexical_anchors),
        "fuzzy_terms": list(result.fuzzy_terms),
        "fuzzy_query": result.fuzzy_query,
        "requested_content_types": list(requested or []),
        "content_type_routing": result.content_type_routing,
        "route_index_versions": dict(result.route_index_versions),
        "hits": hits[:result_limit],
        "diagnostics": [] if diagnostics_level == "none" else diagnostics[:100],
        "stale": False,
        "incomplete": incomplete or limit_reached or truncated,
        "limit_reached": limit_reached,
        "truncated": truncated,
        "timings_ms": {
            "wait": 0.0,
            "search": round((time.perf_counter() - search_started) * 1000, 3),
            "total": round((time.perf_counter() - search_started) * 1000, 3),
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return secrets.compare_digest(self.headers.get("X-PKM-Retrieval-Token", ""), token)

    def payload(self):
        length = min(int(self.headers.get("Content-Length", "0") or 0), 256 * 1024 * 1024)
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_GET(self):
        if not self.authorized():
            self.reply(403, {"ok": False, "error": "Forbidden"})
        elif self.path == "/status":
            self.reply(200, status())
        elif self.path == "/retrieval-learning":
            try:
                self.reply(200, {"ok": True, "learning": retrieval_learning.summary()})
            except sqlite3.Error as error:
                self.reply(503, {"ok": False, "error": f"Retrieval learning unavailable: {error}"})
        elif self.path == "/solutions":
            try:
                with engine_lock:
                    documents = list(ready_documents.values())
                self.reply(200, {"ok": True, **solutions.catalog(documents), "metrics": solution_metrics.summary(),
                                 "learning": retrieval_learning.summary()})
            except (ImportError, OSError, ValueError, sqlite3.Error) as error:
                self.reply(503, {"ok": False, "error": str(error)})
        else:
            self.reply(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if not self.authorized():
            self.reply(403, {"ok": False, "error": "Forbidden"})
            return
        try:
            payload = self.payload()
            if self.path == "/index":
                revision = str(payload.get("corpus_revision") or "")
                if revision and revision in {ready_revision, building_revision}:
                    self.reply(200, {"ok": True, "corpus_revision": revision, "reused": True})
                    return
                threading.Thread(target=build_snapshot, args=(payload,), daemon=True).start()
                self.reply(202, {"ok": True, "corpus_revision": payload.get("corpus_revision")})
            elif self.path == "/update":
                revision = str(payload.get("corpus_revision") or "")
                if revision and revision in {ready_revision, building_revision}:
                    self.reply(200, {"ok": True, "corpus_revision": revision, "reused": True})
                    return
                threading.Thread(target=apply_delta, args=(payload,), daemon=True).start()
                self.reply(202, {"ok": True, "corpus_revision": revision, "upserts": len(payload.get("upserts") or []), "deletes": len(payload.get("deletes") or [])})
            elif self.path == "/search":
                result = search(payload)
                self.reply(200 if result.get("ok") else 503, result)
            elif self.path == "/get":
                result = get_source(payload)
                self.reply(200 if result.get("ok") else 404, result)
            elif self.path == "/retrieval-feedback":
                self.reply(200, retrieval_learning.feedback(payload.get("retrieval_id"),
                                                            payload.get("relevant_source_ids"), payload.get("complete")))
            elif self.path == "/retrieval-learning":
                retrieval_learning.configure(payload.get("enabled"))
                self.reply(200, {"ok": True, "learning": retrieval_learning.summary()})
            elif self.path == "/solutions":
                action = payload.get("action")
                if action in {"enable", "rebuild"}:
                    if payload.get("package_id") is None:
                        raise ValueError("Enabling a solution requires a package ID")
                    solutions.select(payload.get("package_id"), rebuild=action == "rebuild", expected_revision=payload.get("expected_revision"))
                    def rebuild_solution():
                        with build_lock:
                            with engine_lock:
                                documents, revision = list(ready_documents.values()), ready_revision
                            solutions.build(documents, revision)
                    threading.Thread(target=rebuild_solution, daemon=True).start()
                elif action == "disable":
                    solutions.select(None)
                elif action == "delete":
                    solutions.delete(payload.get("package_id"))
                else:
                    raise ValueError("Unknown solution action")
                self.reply(200, {"ok": True, **solutions.status()})
            elif self.path == "/shutdown":
                self.reply(200, {"ok": True})
                threading.Thread(target=server.shutdown, daemon=True).start()
            else:
                self.reply(404, {"ok": False, "error": "Not found"})
        except Exception as error:
            self.reply(400, {"ok": False, "error": str(error)})


if not acquire_lock():
    raise SystemExit(0)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
atomic_json(endpoint_path, {"pid": os.getpid(), "port": server.server_port, "token": token, "engine_version": ENGINE_VERSION, "configuration_hash": CONFIGURATION_HASH})
if snapshot_path.exists():
    def restore_snapshot():
        global last_error
        try:
            build_snapshot(json.loads(snapshot_path.read_text(encoding="utf-8")))
        except Exception as error:
            last_error = str(error)
            update_work("idle", "Retrieval snapshot restore failed")
    threading.Thread(target=restore_snapshot, daemon=True).start()
else:
    update_work("idle", "Retrieval worker ready")


def cleanup(*_args):
    threading.Thread(target=server.shutdown, daemon=True).start()


signal.signal(signal.SIGTERM, cleanup)
try:
    server.serve_forever()
finally:
    try: endpoint_path.unlink()
    except OSError: pass
    try: lock_path.unlink()
    except OSError: pass
    server.server_close()
