#!/usr/bin/env python3
import json
import os
import secrets
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from adaptive_skill_retrieval import (
    ContentType,
    RetrievalEngine,
    SkillDocument,
    academic_bm25_benchmark_route,
    exact_match_route,
)

ENGINE_VERSION = "0.3.0.dev2026091601"
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


def build_snapshot_unlocked(snapshot):
    global ready_engine, ready_documents, ready_source_values, ready_forward, ready_backlinks
    global ready_revision, building_revision, ready_generation, building_generation, last_error
    revision = str(snapshot.get("corpus_revision") or "")
    generation = int(snapshot.get("generation") or (ready_generation + 1))
    if revision and revision == ready_revision:
        return
    building_revision = revision
    building_generation = generation
    try:
        source_values = list(snapshot.get("documents") or [])
        documents = [make_document(value) for value in source_values]
        engine = RetrievalEngine([exact_match_route(), academic_bm25_benchmark_route()])
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
        for value in source_values:
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
        atomic_json(snapshot_path, snapshot)
        with engine_lock:
            ready_engine = engine
            ready_documents = by_version
            ready_source_values = values_by_version
            ready_forward = forward
            ready_backlinks = backlinks
            ready_revision = revision
            ready_generation = generation
            last_error = ""
    except Exception as error:
        last_error = str(error)
    finally:
        building_revision = ""
        building_generation = 0


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
        "supported_routes": ["lexical", "graph", "hybrid"],
        "unsupported_routes": ["semantic"],
        "tokenizers": ["adaptive-skill-retrieval-academic-bm25"],
        "facets": ["content_type", "relation", "direction", "source_scope"],
        "update_mode": "persistent-delta-events-with-full-in-memory-rebuild",
        "limitations": [
            "The current Python engine rebuilds all in-memory lexical state for each accepted delta.",
            "Embeddings and semantic routing are not available.",
            "Cancellation is cooperative at request/deadline boundaries; an in-flight lexical call cannot be interrupted.",
        ],
        "error": last_error,
    }


def search(payload):
    search_started = time.perf_counter()
    with engine_lock:
        engine = ready_engine
        documents = ready_documents
        source_values = ready_source_values
        forward = ready_forward
        backlinks = ready_backlinks
        revision = ready_revision
        generation = ready_generation
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
    allowed_source_ids = set(str(value) for value in ((payload.get("scope") or {}).get("source_ids") or []))
    strict_types = set(str(value) for value in requested or [])
    hits = []
    for hit in result.hits:
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
                "lexical": float(hit.score), "semantic": 0.0, "graph": 0.0, "priority": 1.0,
            },
        })
    diagnostics = []
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
    try:
        build_snapshot(json.loads(snapshot_path.read_text(encoding="utf-8")))
    except Exception as error:
        last_error = str(error)


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
