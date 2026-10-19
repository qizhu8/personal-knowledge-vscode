"""Storage core. The embedding/summary generators and source ACLs belong to adapters."""
from __future__ import annotations

from contextlib import contextmanager
from collections import deque
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct
import time
from typing import Generator


class MemoryError(ValueError):
    pass


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def text(value: object, name: str, limit: int = 65536) -> str:
    if not isinstance(value, str) or not value or len(value.encode()) > limit:
        raise MemoryError(f"{name} must be nonempty text within {limit} bytes.")
    if any(ord(character) < 32 and character not in "\t\n\r" for character in value):
        raise MemoryError(f"{name} contains unsupported control characters.")
    return value


def scope_text(value: object) -> str:
    if value == "":
        return ""
    return text(value, "scope", 1024)


def integer(value: object, name: str, minimum: int = 0, maximum: int = 2**53 - 1) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise MemoryError(f"{name} must be an integer in [{minimum}, {maximum}].")
    return value


SCHEMA = [
    """CREATE TABLE pieces(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0,
        evicted INTEGER NOT NULL DEFAULT 0 CHECK(evicted IN (0,1)),
        kind TEXT NOT NULL DEFAULT 'piece', scope TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE sources(
        id TEXT PRIMARY KEY, chat TEXT NOT NULL, revision TEXT NOT NULL,
        locator TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)""",
    "CREATE TABLE deleted_chats(chat TEXT PRIMARY KEY)",
    """CREATE TABLE leases(
        id TEXT PRIMARY KEY, piece TEXT NOT NULL REFERENCES pieces(id),
        revision INTEGER NOT NULL, expires_at REAL NOT NULL)""",
    "CREATE INDEX active_leases ON leases(piece,expires_at)",
    """CREATE TABLE statements(
        id TEXT PRIMARY KEY, piece TEXT NOT NULL REFERENCES pieces(id),
        sequence INTEGER NOT NULL, body TEXT, status TEXT NOT NULL,
        UNIQUE(piece,sequence))""",
    """CREATE TABLE provenance(
        statement TEXT NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
        source TEXT NOT NULL REFERENCES sources(id),
        PRIMARY KEY(statement,source))""",
    """CREATE TABLE edges(
        parent TEXT NOT NULL REFERENCES pieces(id),
        child TEXT NOT NULL REFERENCES pieces(id),
        relation TEXT NOT NULL, PRIMARY KEY(parent,child,relation))""",
    """CREATE TABLE summaries(
        piece TEXT PRIMARY KEY REFERENCES pieces(id),
        input_revision INTEGER NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL,
        through INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE turns(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, updated REAL NOT NULL)""",
    """CREATE TABLE piece_embeddings(
        piece TEXT NOT NULL REFERENCES pieces(id), representation TEXT NOT NULL,
        revision INTEGER NOT NULL, input_content_hash TEXT NOT NULL,
        embedding_space_id TEXT NOT NULL, dimensions INTEGER NOT NULL,
        encoding TEXT NOT NULL, distance_metric TEXT NOT NULL,
        embedding BLOB, status TEXT NOT NULL,
        PRIMARY KEY(piece,representation,revision,embedding_space_id))""",
    """CREATE TABLE operations(
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL)""",
    """CREATE TABLE changes(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, piece TEXT)""",
    "CREATE INDEX source_chat ON sources(chat,deleted)",
    "CREATE INDEX source_dependents ON provenance(source,statement)",
    "CREATE INDEX statements_page ON statements(piece,sequence)",
    "CREATE INDEX edge_reverse ON edges(child,relation,parent)",
    "CREATE INDEX eviction_order ON pieces(evicted,level,last_used,id)",
    "CREATE INDEX scope_pieces ON pieces(scope,kind,evicted,last_used)",
    "CREATE INDEX embedding_space ON piece_embeddings(embedding_space_id,status,piece)",
]

KINDS = {"piece", "message", "topic", "project"}
RELATIONS = {"abstracts", "part_of", "clarifies", "revises", "supersedes",
             "addresses", "implements", "verifies"}


class Engine:
    """One trusted account/root partition per database; never expose arbitrary SQL."""

    def __init__(self, database: str | Path, identity: str) -> None:
        self.identity = text(identity, "identity", 512)
        file = Path(database)
        if file.is_symlink():
            raise MemoryError("Database must not be a symbolic link.")
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not file.exists():
            with file.open("xb"):
                pass
            file.chmod(0o600)
        self.db = sqlite3.connect(file, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA synchronous=FULL")
            with self._transaction():
                version = self.db.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise MemoryError(f"Unsupported memory schema {version}; database was not replaced.")
                if version == 0:
                    existing = self.db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                    if existing:
                        raise MemoryError("Refusing to initialize an unrelated database.")
                    for statement in SCHEMA:
                        self.db.execute(statement)
                    self.db.execute("CREATE TABLE metadata(identity TEXT NOT NULL)")
                    self.db.execute("INSERT INTO metadata VALUES(?)", (identity,))
                    self.db.execute("PRAGMA user_version=1")
                if self.db.execute("SELECT identity FROM metadata").fetchone()[0] != identity:
                    raise MemoryError("Database account/root identity mismatch.")
            mode = self.db.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if mode != "wal":
                raise MemoryError("Disk-backed WAL is required.")
        except Exception:
            self.db.close()
            raise

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def _transaction(self) -> Generator[None, None, None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def capabilities(self) -> dict:
        return {"module": "pkm-memory-engine", "version": "0.2.0", "policy": "pkm-memory-policy/1",
                "protocol": 1, "schema": 1, "identity": self.identity,
                "sqlite": sqlite3.sqlite_version, "embedding_encoding": "float32-le",
                "model_calls": "caller-executed", "source_acl": "trusted-host-adapter-required"}

    def mutate(self, operation_id: str, method: str, params: dict) -> dict:
        text(operation_id, "operation_id", 256)
        handlers = {"create": self._create, "append": self._append, "link": self._link,
                    "summary_commit": self._summary_commit, "embedding_put": self._embedding_put,
                    "touch": self._touch, "evict": self._evict, "purge_chat": self._purge_chat,
                    "lease_acquire": self._lease_acquire, "lease_release": self._lease_release}
        if method not in handlers:
            raise MemoryError(f"Unsupported mutation {method}.")
        request_hash = digest([method, params])
        with self._transaction():
            old = self.db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
            if old:
                if old["request_hash"] != request_hash:
                    raise MemoryError("Operation ID reused with different input.")
                return json.loads(old["result"])
            result = handlers[method](params)
            self.db.execute("INSERT INTO operations VALUES(?,?,?)",
                            (operation_id, request_hash, json.dumps(result, allow_nan=False)))
            return result

    def _piece(self, piece_id: str) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM pieces WHERE id=?", (text(piece_id, "piece"),)).fetchone()
        if row is None:
            raise MemoryError(f"Piece not found: {piece_id}")
        return row

    def _change(self, kind: str, piece: str | None) -> int:
        cursor = self.db.execute("INSERT INTO changes(kind,piece) VALUES(?,?)", (kind, piece))
        assert cursor.lastrowid is not None
        return cursor.lastrowid

    def _affected(self, piece: str) -> list[str]:
        return [row[0] for row in self.db.execute(
            """WITH RECURSIVE ancestors(id) AS (
                 SELECT ? UNION SELECT e.parent FROM edges e JOIN ancestors a ON e.child=a.id
                 WHERE e.relation='abstracts')
               SELECT id FROM ancestors""", (piece,))]

    def _invalidate(self, piece: str, destructive: bool = False) -> None:
        for affected in self._affected(piece):
            self.db.execute("UPDATE pieces SET revision=revision+1 WHERE id=?", (affected,))
            self.db.execute("UPDATE piece_embeddings SET status='stale',embedding=NULL WHERE piece=?",
                            (affected,))
            if destructive:
                self.db.execute("DELETE FROM summaries WHERE piece=?", (affected,))
            self._change("invalidated", affected)

    def _create(self, p: dict) -> dict:
        piece = text(p["piece"], "piece", 256)
        kind = p.get("kind", "piece")
        if kind not in KINDS:
            raise MemoryError("Unknown Piece kind.")
        self.db.execute("INSERT INTO pieces(id,label,kind,scope) VALUES(?,?,?,?)",
                        (piece, text(p["label"], "label", 1024), kind, scope_text(p.get("scope", ""))))
        self._change("created", piece)
        return {"piece": piece, "revision": 0}

    def _append(self, p: dict) -> dict:
        piece = self._piece(p["piece"])
        if piece["evicted"]:
            raise MemoryError("Evicted Piece requires explicit source reconstruction before append.")
        if piece["revision"] != integer(p["expected_revision"], "expected_revision"):
            raise MemoryError("Stale Piece revision.")
        statement_id = text(p["statement_id"], "statement_id", 256)
        body = text(p["body"], "body")
        status = p.get("status", "observation")
        if status not in {"proposal", "observation", "user-confirmed", "verified", "disputed"}:
            raise MemoryError("Invalid statement status.")
        sources = p["sources"]
        if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
            raise MemoryError("A statement needs 1..100 exact source references.")
        sequence = self.db.execute(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM statements WHERE piece=?", (piece["id"],)
        ).fetchone()[0]
        self.db.execute("INSERT INTO statements VALUES(?,?,?,?,?)",
                        (statement_id, piece["id"], sequence, body, status))
        self.db.execute("UPDATE pieces SET bytes=bytes+? WHERE id=?", (len(body.encode()), piece["id"]))
        for source in sources:
            source_id = text(source["id"], "source id", 256)
            chat = text(source["chat"], "namespaced chat locator", 1024)
            revision = text(source["revision"], "source revision", 256)
            locator = text(source["locator"], "exact section locator", 2048)
            if self.db.execute("SELECT 1 FROM deleted_chats WHERE chat=?", (chat,)).fetchone():
                raise MemoryError("Chat has been deleted; source cannot be recreated.")
            old = self.db.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
            if old and (old["deleted"] or (old["chat"], old["revision"], old["locator"]) !=
                        (chat, revision, locator)):
                raise MemoryError("Source is deleted or source identity/revision conflicts.")
            self.db.execute("INSERT OR IGNORE INTO sources VALUES(?,?,?,?,0)",
                            (source_id, chat, revision, locator))
            self.db.execute("INSERT INTO provenance VALUES(?,?)", (statement_id, source_id))
        self._invalidate(piece["id"])
        return {"piece": piece["id"], "statement_id": statement_id,
                "revision": self._piece(piece["id"])["revision"]}

    def _link(self, p: dict) -> dict:
        parent, child, relation = p["parent"], p["child"], p["relation"]
        self._piece(parent)
        self._piece(child)
        if relation not in RELATIONS:
            raise MemoryError("Unknown relation.")
        if relation == "abstracts" and child in self._affected(parent):
            raise MemoryError("Abstraction cycle rejected.")
        self.db.execute("INSERT INTO edges VALUES(?,?,?)", (parent, child, relation))
        if relation == "abstracts":
            self._invalidate(parent)
            self._raise_levels(parent)
        self._change("linked", parent)
        return {"parent": parent, "child": child, "relation": relation}

    def _raise_levels(self, parent: str) -> None:
        pending = deque([parent])
        queued = {parent}
        while pending:
            piece = pending.popleft()
            queued.remove(piece)
            level = self.db.execute(
                """SELECT COALESCE(MAX(c.level)+1,0) FROM edges e JOIN pieces c ON e.child=c.id
                   WHERE e.parent=? AND e.relation='abstracts'""", (piece,)).fetchone()[0]
            if self._piece(piece)["level"] >= level:
                continue
            self.db.execute("UPDATE pieces SET level=? WHERE id=?", (level, piece))
            for row in self.db.execute(
                    "SELECT parent FROM edges WHERE child=? AND relation='abstracts'", (piece,)):
                if row["parent"] not in queued:
                    pending.append(row["parent"])
                    queued.add(row["parent"])

    def read(self, piece_id: str, after: int = 0, limit: int = 20) -> dict:
        integer(after, "after")
        integer(limit, "limit", 1, 100)
        self.db.execute("BEGIN")
        try:
            piece = dict(self._piece(piece_id))
            summary = self.db.execute("SELECT * FROM summaries WHERE piece=?", (piece_id,)).fetchone()
            candidates = self.db.execute(
                "SELECT * FROM statements WHERE piece=? AND sequence>? ORDER BY sequence LIMIT ?",
                (piece_id, after, limit)).fetchall()
            rows: list[dict] = []
            payload_bytes = len(json.dumps(summary["body"], ensure_ascii=False).encode()) if summary else 0
            for candidate in candidates:
                row = dict(candidate)
                payload_bytes += len(json.dumps(row, ensure_ascii=False).encode())
                if rows and payload_bytes > 192 * 1024:
                    break
                rows.append(row)
            return {"piece": piece, "summary": dict(summary) if summary else None,
                    "summary_current": bool(summary and summary["input_revision"] == piece["revision"]),
                    "statements": rows, "next": rows[-1]["sequence"] if rows else after}
        finally:
            self.db.execute("ROLLBACK")

    def sources(self, statement_id: str, after: str = "", limit: int = 20) -> list[dict]:
        text(statement_id, "statement_id", 256)
        integer(limit, "limit", 1, 50)
        return [dict(row) for row in self.db.execute(
            """SELECT r.id,r.chat,r.revision,r.locator FROM sources r
               JOIN provenance p ON p.source=r.id WHERE p.statement=? AND r.deleted=0
               AND r.id>? ORDER BY r.id LIMIT ?""", (statement_id, after, limit))]

    def neighbors(self, piece_id: str, after: str = "", limit: int = 50) -> list[dict]:
        self._piece(piece_id)
        integer(limit, "limit", 1, 100)
        return [dict(row) for row in self.db.execute(
            """SELECT parent,child,relation FROM edges WHERE (parent=? OR child=?)
               AND parent||char(31)||child||char(31)||relation>?
               ORDER BY parent,child,relation LIMIT ?""", (piece_id, piece_id, after, limit))]

    def _summary_commit(self, p: dict) -> dict:
        piece = self._piece(p["piece"])
        revision = integer(p["expected_revision"], "expected_revision")
        if piece["evicted"] or revision != piece["revision"]:
            raise MemoryError("Summary input changed or Piece was evicted.")
        body = text(p["body"], "summary", 32768)
        through = integer(p.get("through", 0), "through")
        content_hash = digest(body)
        previous = self.db.execute("SELECT * FROM summaries WHERE piece=?", (piece["id"],)).fetchone()
        if previous and previous["input_revision"] == revision:
            if previous["body"] != body:
                raise MemoryError("Summary is immutable for this input revision.")
            return {"piece": piece["id"], "revision": revision, "content_hash": content_hash}
        self.db.execute("INSERT OR REPLACE INTO summaries VALUES(?,?,?,?,?)",
                        (piece["id"], revision, body, content_hash, through))
        self.db.execute(
            "UPDATE piece_embeddings SET status='stale',embedding=NULL WHERE piece=? AND representation='summary'",
            (piece["id"],))
        for parent in self.db.execute(
                "SELECT parent FROM edges WHERE child=? AND relation='abstracts'", (piece["id"],)).fetchall():
            self._invalidate(parent["parent"])
        self._change("summary", piece["id"])
        return {"piece": piece["id"], "revision": revision, "content_hash": content_hash}

    def _embedding_put(self, p: dict) -> dict:
        piece = self._piece(p["piece"])
        revision = integer(p["revision"], "revision")
        if piece["evicted"] or piece["revision"] != revision or p["representation"] != "summary":
            raise MemoryError("Embedding requires a current, readable summary revision.")
        summary = self.db.execute("SELECT * FROM summaries WHERE piece=?", (piece["id"],)).fetchone()
        if not summary or summary["input_revision"] != revision or summary["content_hash"] != p["input_content_hash"]:
            raise MemoryError("Embedding input hash/revision mismatch.")
        vector = p["embedding"]
        dimensions = integer(p["dimensions"], "dimensions", 1, 65536)
        if not isinstance(vector, list) or len(vector) != dimensions:
            raise MemoryError("Embedding dimensions mismatch.")
        if any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 3.402823466e38
               for v in vector):
            raise MemoryError("Embedding values must be finite float32 values.")
        metric = p["distance_metric"]
        if metric not in {"cosine", "dot", "l2"}:
            raise MemoryError("Unsupported distance metric.")
        if metric == "cosine" and not any(vector):
            raise MemoryError("Cosine embedding cannot be a zero vector.")
        space = text(p["embedding_space_id"], "embedding_space_id", 512)
        existing = self.db.execute(
            "SELECT dimensions,distance_metric FROM piece_embeddings WHERE embedding_space_id=? LIMIT 1",
            (space,)).fetchone()
        if existing and tuple(existing) != (dimensions, metric):
            raise MemoryError("Embedding space dimensions/metric conflict.")
        self.db.execute("INSERT OR REPLACE INTO piece_embeddings VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (piece["id"], "summary", revision, summary["content_hash"], space,
                         dimensions, "float32-le", metric, struct.pack(f"<{dimensions}f", *vector), "ready"))
        self._change("embedding", piece["id"])
        return {"piece": piece["id"], "revision": revision, "dimensions": dimensions, "space": space}

    def embedding(self, piece_id: str, space: str) -> dict:
        piece = self._piece(piece_id)
        row = self.db.execute(
            """SELECT * FROM piece_embeddings WHERE piece=? AND embedding_space_id=?
               AND revision=? AND status='ready'""", (piece_id, space, piece["revision"])).fetchone()
        if not row:
            return {"piece": piece_id, "embedding": None, "status": "unavailable"}
        result = dict(row)
        result["embedding"] = list(struct.unpack(f"<{row['dimensions']}f", row["embedding"]))
        return result

    def _touch(self, p: dict) -> dict:
        piece = self._piece(p["piece"])
        if piece["evicted"] or p["reason"] not in {"read", "expand", "sent"}:
            raise MemoryError("Only meaningful use of readable content refreshes LRU.")
        sequence = self._change("access", piece["id"])
        self.db.execute("UPDATE pieces SET last_used=? WHERE id=?", (sequence, piece["id"]))
        return {"piece": piece["id"], "last_used": sequence}

    def _lease_acquire(self, p: dict) -> dict:
        piece = self._piece(p["piece"])
        revision = integer(p["expected_revision"], "expected_revision")
        if piece["evicted"] or piece["revision"] != revision:
            raise MemoryError("Cannot lease an unavailable or stale Piece.")
        lease = text(p["lease_id"], "lease_id", 256)
        ttl = integer(p["ttl_seconds"], "ttl_seconds", 1, 300)
        self.db.execute("DELETE FROM leases WHERE expires_at<=?", (time.time(),))
        self.db.execute("INSERT INTO leases VALUES(?,?,?,?)",
                        (lease, piece["id"], revision, time.time() + ttl))
        return {"lease_id": lease, "piece": piece["id"], "revision": revision}

    def _lease_release(self, p: dict) -> dict:
        lease = text(p["lease_id"], "lease_id", 256)
        self.db.execute("DELETE FROM leases WHERE id=?", (lease,))
        return {"lease_id": lease}

    def _evict(self, p: dict) -> dict:
        count = integer(p["count"], "count", 1, 100)
        protected = p.get("protected", [])
        if not isinstance(protected, list) or len(protected) > 1000:
            raise MemoryError("Invalid protected Piece list.")
        for piece in protected:
            self._piece(piece)
        placeholders = ",".join("?" for _ in protected) or "NULL"
        scope = p.get("scope")
        query = """SELECT id FROM pieces WHERE evicted=0 AND NOT EXISTS(
                   SELECT 1 FROM leases WHERE leases.piece=pieces.id AND expires_at>?)"""
        args: list = [time.time()]
        if scope is not None:
            query += " AND scope=?"
            args.append(text(scope, "scope", 1024))
        if protected:
            query += f" AND id NOT IN ({placeholders})"
        query += " ORDER BY level,last_used,id LIMIT ?"
        rows = self.db.execute(query.replace("SELECT id FROM", "SELECT id,bytes FROM"),
                               (*args, *protected, count)).fetchall()
        free_bytes = p.get("free_bytes")
        if free_bytes is not None:
            needed, kept = integer(free_bytes, "free_bytes"), []
            for row in rows:
                if needed <= 0:
                    break
                kept.append(row)
                needed -= row["bytes"]
            rows = kept
        for row in rows:
            piece = row["id"]
            self.db.execute("UPDATE statements SET body=NULL WHERE piece=?", (piece,))
            self.db.execute("DELETE FROM summaries WHERE piece=?", (piece,))
            self.db.execute("DELETE FROM piece_embeddings WHERE piece=?", (piece,))
            self.db.execute("UPDATE pieces SET evicted=1,bytes=0 WHERE id=?", (piece,))
            self._change("evicted", piece)
        return {"evicted": [row["id"] for row in rows], "pressure": len(rows) < count}

    def _purge_chat(self, p: dict) -> dict:
        chat = text(p["chat"], "chat", 1024)
        self.db.execute("INSERT OR IGNORE INTO deleted_chats VALUES(?)", (chat,))
        rows = self.db.execute(
            """SELECT DISTINCT s.id,s.piece FROM statements s JOIN provenance p ON p.statement=s.id
               JOIN sources r ON r.id=p.source WHERE r.chat=?""", (chat,)).fetchall()
        for row in rows:
            self._invalidate(row["piece"], destructive=True)
            self.db.execute(
                """UPDATE pieces SET bytes=MAX(0,bytes-COALESCE((SELECT LENGTH(CAST(body AS BLOB))
                   FROM statements WHERE id=?),0)) WHERE id=?""", (row["id"], row["piece"]))
            self.db.execute("DELETE FROM statements WHERE id=?", (row["id"],))
            if not self.db.execute("SELECT 1 FROM statements WHERE piece=?", (row["piece"],)).fetchone():
                self.db.execute("UPDATE pieces SET label='',evicted=1,bytes=0 WHERE id=?", (row["piece"],))
        self.db.execute("UPDATE sources SET deleted=1,locator='' WHERE chat=?", (chat,))
        self._change("purged", None)
        return {"removed_statements": len(rows)}

    def pieces(self, scope: str, kind: str, limit: int = 50, query: str = "") -> list[dict]:
        """Readable Pieces of one scope/kind, most recently used first; optional label/summary substring."""
        text(scope, "scope", 1024)
        if kind not in KINDS:
            raise MemoryError("Unknown Piece kind.")
        integer(limit, "limit", 1, 200)
        text(query, "query", 512) if query else None
        sql = """SELECT p.id,p.label,p.kind,p.level,p.revision,p.last_used,p.bytes,
                        s.body AS summary,(s.input_revision=p.revision) AS summary_current
                 FROM pieces p LEFT JOIN summaries s ON s.piece=p.id
                 WHERE p.scope=? AND p.kind=? AND p.evicted=0"""
        args: list = [scope, kind]
        if query:
            sql += " AND (instr(lower(p.label),lower(?))>0 OR instr(lower(COALESCE(s.body,'')),lower(?))>0)"
            args += [query, query]
        sql += " ORDER BY p.last_used DESC,p.rowid DESC LIMIT ?"
        return [dict(row) for row in self.db.execute(sql, (*args, limit))]

    def children(self, piece_id: str, before: int = 0, limit: int = 20, kind: str = "") -> dict:
        """Abstraction children newest-first by creation order, paged with an opaque rowid cursor."""
        self._piece(piece_id)
        integer(before, "before")
        integer(limit, "limit", 1, 100)
        sql = """SELECT c.rowid AS cursor,c.id,c.label,c.kind,c.level,c.revision,c.evicted,c.bytes
                 FROM edges e JOIN pieces c ON c.id=e.child
                 WHERE e.parent=? AND e.relation='abstracts'"""
        args: list = [piece_id]
        if kind:
            sql += " AND c.kind=?"
            args.append(kind)
        if before:
            sql += " AND c.rowid<?"
            args.append(before)
        rows = [dict(row) for row in self.db.execute(sql + " ORDER BY c.rowid DESC LIMIT ?", (*args, limit))]
        return {"children": rows, "next": rows[-1]["cursor"] if len(rows) == limit else 0}

    def parents(self, piece_id: str, limit: int = 50) -> list[dict]:
        self._piece(piece_id)
        integer(limit, "limit", 1, 200)
        return [dict(row) for row in self.db.execute(
            """SELECT p.id,p.label,p.kind,p.level FROM edges e JOIN pieces p ON p.id=e.parent
               WHERE e.child=? AND e.relation='abstracts' AND p.evicted=0 ORDER BY p.rowid LIMIT ?""",
            (piece_id, limit))]

    def usage(self, scope: str = "") -> dict:
        sql = "SELECT COALESCE(SUM(bytes),0),COUNT(*) FROM pieces WHERE evicted=0"
        row = self.db.execute(sql + (" AND scope=?" if scope else ""), (scope,) if scope else ()).fetchone()
        return {"bytes": row[0], "pieces": row[1]}

    def turn_get(self, turn_id: str) -> dict | None:
        row = self.db.execute("SELECT state FROM turns WHERE id=?", (text(turn_id, "turn", 256),)).fetchone()
        return json.loads(row[0]) if row else None

    def turn_put(self, turn_id: str, scope: str, state: dict) -> None:
        with self._transaction():
            self.db.execute("INSERT OR REPLACE INTO turns VALUES(?,?,?,?)",
                            (text(turn_id, "turn", 256), scope, json.dumps(state, ensure_ascii=False), time.time()))
            self.db.execute("DELETE FROM turns WHERE updated<?", (time.time() - 7 * 86400,))

    def changes(self, after: int = 0, limit: int = 50) -> list[dict]:
        integer(after, "after")
        integer(limit, "limit", 1, 100)
        return [dict(row) for row in self.db.execute(
            "SELECT * FROM changes WHERE sequence>? ORDER BY sequence LIMIT ?", (after, limit))]

    def backup(self, destination: str | Path) -> None:
        file = Path(destination)
        if file.exists() or file.is_symlink():
            raise MemoryError("Backup destination must not already exist.")
        # Reserve the path atomically before connecting.
        with file.open("xb"):
            pass
        file.chmod(0o600)
        target = sqlite3.connect(file)
        try:
            self.db.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MemoryError("Backup integrity verification failed.")
        finally:
            target.close()
