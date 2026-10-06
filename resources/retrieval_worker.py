#!/usr/bin/env python3
import json
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

from adaptive_skill_retrieval import (
    ContentType,
    RetrievalEngine,
    SkillDocument,
    academic_bm25_benchmark_route,
    exact_match_route,
)

ENGINE_VERSION = "0.3.0.dev2026100504"
CONFIGURATION_HASH = sys.argv[2] if len(sys.argv) > 2 else "exact-bm25-academic-v1"
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


def make_document(value):
    raw_type = str(value.get("content_type") or "skill")
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


from retrieval_solutions import SolutionManager, SolutionMetrics
solutions = SolutionManager(state_dir, atomic_json)
solution_metrics = SolutionMetrics(state_dir)


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
            document.version: {**value, "content_hash": document.version.content_hash}
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
    return {
        "ok": True,
        "engine_version": ENGINE_VERSION,
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
        "skill_serving": {
            "enabled": bool(selected_package) if solutions.managed else serving_attempted,
            "ready": imported_path is not None if solutions.managed else serving_ready,
            "release_id": active_path.release_id if active_path else None,
            "architecture_id": active_path.architecture_id if active_path else None,
            "validation": active_path.validation if active_path else None,
            "fallback": "exact-bm25", "error": imported_error if solutions.managed else serving_error,
            "scope": "explicit skill-only fuzzy queries; other retrieval contracts remain lexical",
        },
        "supported_routes": ["lexical", "graph", "hybrid"],
        "unsupported_routes": ["semantic"],
        "tokenizers": ["adaptive-skill-retrieval-academic-bm25"],
        "facets": ["content_type", "relation", "direction", "source_scope"],
        "update_mode": "persistent-delta-events-with-full-in-memory-rebuild",
        "limitations": [
            "The current Python engine rebuilds all in-memory lexical state for each accepted delta.",
            "General semantic routing is unavailable; an admitted frozen path may serve Skill-only fuzzy queries.",
            "Cancellation is cooperative at request/deadline boundaries; an in-flight lexical call cannot be interrupted.",
        ],
        "error": last_error,
        "work_state": work_state,
        "work_detail": work_detail,
        "work_current": work_current,
        "work_total": work_total,
        "work_updated_at": work_updated_at,
    }


def search(payload):
    started = time.perf_counter()
    epoch, requested_package, _, _ = solutions.capture()
    result = search_unmeasured(payload)
    if solutions.capture()[0] != epoch:
        result = {"ok": False, "code": "solution-changed", "error": "Solution changed during this request; retry against the active path."}
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
    if route == "semantic":
        return {"ok": False, "error": "Semantic retrieval is not supported by the active engine.", "code": "unsupported-route"}
    if route not in {"lexical", "graph", "hybrid"}:
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
    engine_filter = []
    for value in requested or []:
        try: engine_filter.append(ContentType(str(value)))
        except ValueError: engine_filter.append(ContentType("note"))
    content_filter = engine_filter if requested is not None else None
    result = engine.search(str(payload.get("query") or ""), limit=max(1, min(int(payload.get("limit") or 5), 100)), content_type_filter=content_filter)
    selected_hits = result.hits
    serving_used = False
    fallback_error = package_error if solutions.managed else serving_error
    if requested_package and skill_path is None and not fallback_error:
        fallback_error = "Imported solution is building; using Exact/BM25"
    allowed_source_ids = set(str(value) for value in ((payload.get("scope") or {}).get("source_ids") or []))
    strict_types = set(str(value) for value in requested or [])
    if skill_path is not None and (solutions.managed or requested == ["skill"]) and result.query_intent.value == "semantic":
        try:
            if solutions.managed:
                allowed = {
                    version for version, value in source_values.items()
                    if (not strict_types or value.get("content_type") in strict_types)
                    and (not allowed_source_ids or str(value.get("source_id") or version.skill_id) in allowed_source_ids)
                    and str(value.get("visibility") or "available") == "available"
                    and not ((payload.get("scope") or {}).get("include_read_only") is False and value.get("read_only"))
                }
                frozen_hits = skill_path.search(str(payload.get("query") or ""), len(skill_path.documents), allowed)
            else:
                frozen_hits = skill_path.search(str(payload.get("query") or ""), len(skill_path.documents))
            versions_by_id = {version.skill_id: version for version in documents}
            from dataclasses import replace
            selected_hits = frozen_hits if solutions.managed else [
                replace(hit, skill_version=versions_by_id["skill:" + hit.skill_version.skill_id])
                for hit in frozen_hits
            ]
            serving_used = True
        except Exception as error:
            fallback_error = f"Imported text search failed: {type(error).__name__}: {error}"
            print(fallback_error, file=sys.stderr, flush=True)
    allowed_source_ids = set(str(value) for value in ((payload.get("scope") or {}).get("source_ids") or []))
    strict_types = set(str(value) for value in requested or [])
    hits = []
    for hit in selected_hits:
        document = documents[hit.skill_version]
        source_value = source_values[hit.skill_version]
        source_id = str(source_value.get("source_id") or hit.skill_version.skill_id)
        if allowed_source_ids and source_id not in allowed_source_ids:
            continue
        if str(source_value.get("visibility") or "available") != "available":
            continue
        if (payload.get("scope") or {}).get("include_read_only") is False and bool(source_value.get("read_only")):
            continue
        if strict_types and str(source_value.get("content_type") or "") not in strict_types:
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
            "score_components": {
                "lexical": 0.0 if serving_used else float(hit.score),
                "semantic": float(hit.score) if serving_used else 0.0, "graph": 0.0, "priority": 1.0,
            },
        })
    diagnostics = []
    if fallback_error:
        diagnostics.append({"code": "skill-serving-fallback", "message": fallback_error})
    incomplete = False
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
    diagnostics_level = str(payload.get("diagnostics") or "summary")
    return {
        "ok": True,
        "schema": "pkm.retrieval.result/v1",
        "request_id": str(payload.get("request_id") or ""),
        "corpus_revision": revision,
        "ready_generation": generation,
        "route": route,
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
        "requested_content_types": [value.value for value in result.requested_content_types],
        "content_type_routing": result.content_type_routing,
        "route_index_versions": dict(result.route_index_versions),
        "hits": hits[:max(1, min(int(payload.get("limit") or 5), 100))],
        "diagnostics": [] if diagnostics_level == "none" else diagnostics[:100],
        "stale": False,
        "incomplete": incomplete,
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
        elif self.path == "/solutions":
            try:
                with engine_lock:
                    documents = list(ready_documents.values())
                self.reply(200, {"ok": True, **solutions.catalog(documents), "metrics": solution_metrics.summary()})
            except (ImportError, OSError, ValueError) as error:
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
            elif self.path == "/solutions":
                action = payload.get("action")
                if action in {"enable", "rebuild"}:
                    if payload.get("package_id") is None:
                        raise ValueError("Enabling a solution requires a package ID")
                    solutions.select(payload.get("package_id"), rebuild=action == "rebuild")
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
