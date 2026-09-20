#!/usr/bin/env python3
import json
import os
import secrets
import signal
import sys
import threading
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
ready_revision = ""
building_revision = ""
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
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    try: os.chmod(temp, 0o600)
    except OSError: pass
    os.replace(temp, path)


def make_document(value):
    return SkillDocument.create(
        skill_id=str(value["skill_id"]),
        title=str(value.get("title") or ""),
        description=str(value.get("description") or ""),
        body=str(value.get("body") or ""),
        content_type=ContentType(str(value.get("content_type") or "skill")),
        source_uri=str(value.get("source_uri") or ""),
        metadata={str(k): str(v) for k, v in (value.get("metadata") or {}).items()},
        provenance=dict(value.get("provenance") or {}),
        read_only=bool(value.get("read_only")),
    )


def build_snapshot_unlocked(snapshot):
    global ready_engine, ready_documents, ready_revision, building_revision, last_error
    revision = str(snapshot.get("corpus_revision") or "")
    if revision and revision == ready_revision:
        return
    building_revision = revision
    try:
        documents = [make_document(value) for value in snapshot.get("documents") or []]
        engine = RetrievalEngine([exact_match_route(), academic_bm25_benchmark_route()])
        engine.index(documents)
        by_version = {document.version: document for document in documents}
        atomic_json(snapshot_path, snapshot)
        with engine_lock:
            ready_engine = engine
            ready_documents = by_version
            ready_revision = revision
            last_error = ""
    except Exception as error:
        last_error = str(error)
    finally:
        building_revision = ""


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
        build_snapshot_unlocked({"corpus_revision": str(delta.get("corpus_revision") or ""), "documents": list(documents.values())})


def status():
    return {
        "ok": True,
        "engine_version": ENGINE_VERSION,
        "configuration_hash": CONFIGURATION_HASH,
        "pid": os.getpid(),
        "corpus_revision": ready_revision,
        "building_revision": building_revision,
        "ready": ready_engine is not None,
        "document_count": len(ready_documents),
        "error": last_error,
    }


def search(payload):
    with engine_lock:
        engine = ready_engine
        documents = ready_documents
        revision = ready_revision
    if engine is None:
        return {"ok": False, "error": "Retrieval index is not ready.", "corpus_revision": revision}
    requested = payload.get("content_type_filter")
    content_filter = [ContentType(str(value)) for value in requested] if requested is not None else None
    result = engine.search(str(payload.get("query") or ""), limit=max(1, min(int(payload.get("limit") or 5), 100)), content_type_filter=content_filter)
    hits = []
    for hit in result.hits:
        document = documents[hit.skill_version]
        hits.append({
            "rank": hit.rank,
            "score": hit.score,
            "skill_id": hit.skill_version.skill_id,
            "content_hash": hit.skill_version.content_hash,
            "content_type": document.content_type.value,
            "source_uri": document.source_uri,
            "title": document.title,
            "description": document.description,
            "metadata": dict(document.metadata),
            "provenance": dict(document.provenance),
            "read_only": document.read_only,
            "contributing_routes": list(hit.contributing_routes),
        })
    return {
        "ok": True,
        "request_id": str(payload.get("request_id") or ""),
        "corpus_revision": revision,
        "query_intent": result.query_intent.value,
        "intent_signals": list(result.intent_signals),
        "exact_terms": list(result.exact_terms),
        "lexical_anchors": list(result.lexical_anchors),
        "fuzzy_terms": list(result.fuzzy_terms),
        "fuzzy_query": result.fuzzy_query,
        "requested_content_types": [value.value for value in result.requested_content_types],
        "content_type_routing": result.content_type_routing,
        "route_index_versions": dict(result.route_index_versions),
        "hits": hits,
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
