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
    def __init__(self, message: str, code: str = "INVALID_ARGUMENT") -> None:
        super().__init__(message)
        self.code = code


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
EXPLICIT_MEMORY_SCHEMA = [
    """CREATE TABLE explicit_memories(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','revoked')),
        created_at REAL NOT NULL, updated_at REAL NOT NULL)""",
    """CREATE TABLE explicit_memory_revisions(
        memory_id TEXT NOT NULL REFERENCES explicit_memories(id),
        revision INTEGER NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','superseded','revoked')),
        created_at REAL NOT NULL, operation_id TEXT NOT NULL,
        PRIMARY KEY(memory_id,revision))""",
    """CREATE TABLE explicit_memory_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
        scope TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, actor TEXT NOT NULL, decision_id TEXT,
        operation_id TEXT NOT NULL, created_at REAL NOT NULL)""",
    "CREATE INDEX explicit_memory_scope_status ON explicit_memories(scope,status,updated_at)",
    "CREATE INDEX explicit_memory_audit ON explicit_memory_events(scope,memory_id,sequence)",
]


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
        self._savepoint_sequence = 0
        try:
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA synchronous=FULL")
            with self._transaction():
                version = self.db.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1, 2):
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
                    version = 1
                if version == 1:
                    for statement in EXPLICIT_MEMORY_SCHEMA:
                        self.db.execute(statement)
                    self.db.execute("PRAGMA user_version=2")
                if self.db.execute("SELECT identity FROM metadata").fetchone()[0] != identity:
                    raise MemoryError("Database account/root identity mismatch.")
            mode = self.db.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if mode != "wal":
                raise MemoryError("Disk-backed WAL is required.")
            self.reconciliation = self._reconcile()
        except Exception:
            self.db.close()
            raise

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def _transaction(self, *, immediate: bool = True) -> Generator[None, None, None]:
        # Policy steps group multiple mutations; savepoints preserve their outer transaction.
        nested = self.db.in_transaction
        self._savepoint_sequence += 1
        savepoint = f"memory_{self._savepoint_sequence}"
        self.db.execute(f"SAVEPOINT {savepoint}" if nested else
                        "BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield
            self.db.execute(f"RELEASE {savepoint}" if nested else "COMMIT")
        except BaseException:
            # SQLite may already have rolled back after an I/O or disk-full error.
            if self.db.in_transaction:
                if nested:
                    self.db.execute(f"ROLLBACK TO {savepoint}")
                    self.db.execute(f"RELEASE {savepoint}")
                else:
                    self.db.execute("ROLLBACK")
            raise

    def _reconcile(self) -> dict:
        """Repair legacy dangling projections. All payloads, including blobs, live in SQLite.

        There is no external content store or file/DB commit gap requiring pending intents.
        Missing payloads are not invented: readers report them explicitly.
        Turn age is not an integrity failure; scope state and resumable work persist.
        """
        removed = 0
        with self._transaction():
            for table, predicate in (
                ("statements", "piece NOT IN (SELECT id FROM pieces)"),
                ("provenance", "statement NOT IN (SELECT id FROM statements) OR source NOT IN (SELECT id FROM sources)"),
                ("sources", "deleted=0 AND id NOT IN (SELECT source FROM provenance)"),
                ("edges", "parent NOT IN (SELECT id FROM pieces) OR child NOT IN (SELECT id FROM pieces)"),
                ("leases", "piece NOT IN (SELECT id FROM pieces) OR expires_at<=?"),
                ("summaries", "piece NOT IN (SELECT id FROM pieces WHERE evicted=0)"),
                ("piece_embeddings", "piece NOT IN (SELECT id FROM pieces WHERE evicted=0)"),
            ):
                args = (time.time(),) if table == "leases" else ()
                cursor = self.db.execute(f"DELETE FROM {table} WHERE {predicate}", args)
                removed += cursor.rowcount
            missing = self.db.execute(
                "SELECT COUNT(*) FROM statements s JOIN pieces p ON p.id=s.piece "
                "WHERE s.body IS NULL AND p.evicted=0").fetchone()[0]
            missing += self.db.execute(
                "SELECT COUNT(*) FROM pieces p WHERE p.evicted=0 AND p.kind='message' "
                "AND NOT EXISTS(SELECT 1 FROM statements s WHERE s.piece=p.id)").fetchone()[0]
            missing += self.db.execute(
                "SELECT COUNT(*) FROM piece_embeddings WHERE status='ready' AND embedding IS NULL").fetchone()[0]
        return {"status": "missing" if missing else "ok", "removed_rows": removed,
                "missing_payloads": missing, "content_storage": "sqlite"}

    def capabilities(self) -> dict:
        return {"module": "pkm-memory-engine", "version": "0.2.0", "policy": "pkm-memory-policy/1",
                "protocol": 1, "schema": 2, "identity": self.identity,
                "sqlite": sqlite3.sqlite_version, "embedding_encoding": "float32-le",
                "model_calls": "caller-executed", "source_acl": "trusted-host-adapter-required",
                "reconciliation": dict(self.reconciliation)}

    def mutate(self, operation_id: str, method: str, params: dict) -> dict:
        text(operation_id, "operation_id", 256)
        handlers = {"create": self._create, "append": self._append, "link": self._link,
                    "summary_commit": self._summary_commit, "embedding_put": self._embedding_put,
                    "touch": self._touch, "evict": self._evict, "purge_chat": self._purge_chat,
                    "lease_acquire": self._lease_acquire, "lease_release": self._lease_release,
                    "explicit_propose": lambda p: self._explicit_propose(p, operation_id),
                    "explicit_confirm": lambda p: self._explicit_confirm(p, operation_id),
                    "explicit_revise": lambda p: self._explicit_revise(p, operation_id),
                    "explicit_revoke": lambda p: self._explicit_revoke(p, operation_id)}
        if method not in handlers:
            raise MemoryError(f"Unsupported mutation {method}.")
        request_hash = digest([method, params])
        with self._transaction():
            old = self.db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
            if old:
                if old["request_hash"] != request_hash:
                    raise MemoryError("Operation ID reused with different input.", "CONFLICT")
                return json.loads(old["result"])
            result = handlers[method](params)
            self.db.execute("INSERT INTO operations VALUES(?,?,?)",
                            (operation_id, request_hash, json.dumps(result, allow_nan=False)))
            return result

    @staticmethod
    def _explicit_keys(params: dict, expected: set[str]) -> None:
        if set(params) != expected:
            raise MemoryError(f"Expected exactly these explicit-memory fields: {', '.join(sorted(expected))}.")

    @staticmethod
    def _explicit_sources(value: object) -> list[dict]:
        if not isinstance(value, list) or not 1 <= len(value) <= 32:
            raise MemoryError("Explicit memory needs 1..32 exact source references.")
        sources = []
        for source in value:
            if not isinstance(source, dict) or set(source) != {"id", "chat", "revision", "locator"}:
                raise MemoryError("Invalid explicit-memory source reference.")
            sources.append({
                "id": text(source["id"], "source id", 256),
                "chat": text(source["chat"], "source chat", 1024),
                "revision": text(source["revision"], "source revision", 256),
                "locator": text(source["locator"], "source locator", 2048),
            })
        if len(json.dumps(sources, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 4096:
            raise MemoryError("Explicit-memory source references exceed 4096 UTF-8 bytes in total.")
        return sources

    @staticmethod
    def _explicit_authorization(value: object) -> tuple[str, str]:
        if not isinstance(value, dict) or set(value) != {"decision_id", "actor_id"}:
            raise MemoryError("A Host-authorized decision is required.", "ACCESS_DENIED")
        return (text(value["decision_id"], "Host decision id", 256),
                text(value["actor_id"], "Host actor id", 256))

    def _explicit_event(self, memory_id: str, scope: str, revision: int, action: str,
                        status: str, actor: str, decision_id: str | None,
                        operation_id: str, now: float) -> None:
        self.db.execute(
            """INSERT INTO explicit_memory_events
               (memory_id,scope,revision,action,status,actor,decision_id,operation_id,created_at)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (memory_id, scope, revision, action, status, actor, decision_id, operation_id, now))
        self._change(f"explicit_memory_{action}", memory_id)

    def _explicit_create_revision(self, memory_id: str, revision: int, content: str,
                                  sources: list[dict], status: str, operation_id: str,
                                  now: float) -> None:
        self.db.execute(
            """INSERT INTO explicit_memory_revisions
               (memory_id,revision,content,sources,status,created_at,operation_id)
               VALUES(?,?,?,?,?,?,?)""",
            (memory_id, revision, content, json.dumps(sources, ensure_ascii=False),
             status, now, operation_id))

    def _explicit_record(self, row: sqlite3.Row, version: sqlite3.Row | None = None) -> dict:
        version = version or self.db.execute(
            "SELECT * FROM explicit_memory_revisions WHERE memory_id=? AND revision=?",
            (row["id"], row["revision"])).fetchone()
        if version is None:
            raise MemoryError("Explicit memory revision is missing.", "NOT_AVAILABLE")
        return {
            "id": row["id"], "scope": row["scope"], "revision": version["revision"],
            "current_revision": row["revision"], "status": version["status"],
            "current_status": row["status"], "content": version["content"],
            "sources": json.loads(version["sources"]), "created_at": row["created_at"],
            "updated_at": row["updated_at"], "revision_created_at": version["created_at"],
        }

    def _explicit_propose(self, p: dict, operation_id: str) -> dict:
        self._explicit_keys(p, {"id", "scope", "content", "sources"})
        memory_id = text(p["id"], "memory id", 256)
        scope = text(p["scope"], "scope", 1024)
        content = text(p["content"], "memory content", 4096)
        sources = self._explicit_sources(p["sources"])
        now = time.time()
        self.db.execute(
            "INSERT INTO explicit_memories VALUES(?,?,1,'pending',?,?)",
            (memory_id, scope, now, now))
        self._explicit_create_revision(memory_id, 1, content, sources, "pending", operation_id, now)
        self._explicit_event(memory_id, scope, 1, "proposed", "pending", "caller", None, operation_id, now)
        return self._explicit_record(self.db.execute(
            "SELECT * FROM explicit_memories WHERE id=?", (memory_id,)).fetchone())

    def _explicit_owned(self, memory_id: object, scope: object, expected_revision: object) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM explicit_memories WHERE id=? AND scope=?",
                              (text(memory_id, "memory id", 256), text(scope, "scope", 1024))).fetchone()
        if row is None:
            raise MemoryError("Explicit memory not found in this scope.", "NOT_AVAILABLE")
        if row["revision"] != integer(expected_revision, "expected_revision", 1):
            raise MemoryError("Stale explicit-memory revision.", "CONFLICT")
        return row

    def _explicit_transition(self, p: dict, operation_id: str, action: str,
                             new_status: str, content: str | None = None,
                             sources: list[dict] | None = None) -> dict:
        decision_id, actor_id = self._explicit_authorization(p["host_authorization"])
        row = self._explicit_owned(p["id"], p["scope"], p["expected_revision"])
        if row["status"] == "revoked":
            raise MemoryError("Revoked explicit memory cannot be changed.", "CONFLICT")
        old = self.db.execute(
            "SELECT content,sources FROM explicit_memory_revisions WHERE memory_id=? AND revision=?",
            (row["id"], row["revision"])).fetchone()
        if old is None:
            raise MemoryError("Explicit memory revision is missing.", "NOT_AVAILABLE")
        if row["status"] == "confirmed" and action == "confirmed":
            raise MemoryError("Explicit memory is already confirmed.", "CONFLICT")
        content = content if content is not None else old["content"]
        sources = sources if sources is not None else json.loads(old["sources"])
        now = time.time()
        revision = row["revision"] + 1
        self.db.execute(
            "UPDATE explicit_memory_revisions SET status='superseded' WHERE memory_id=? AND revision=?",
            (row["id"], row["revision"]))
        self.db.execute("UPDATE explicit_memories SET revision=?,status=?,updated_at=? WHERE id=?",
                        (revision, new_status, now, row["id"]))
        self._explicit_create_revision(row["id"], revision, content, sources, new_status, operation_id, now)
        self._explicit_event(row["id"], row["scope"], revision, action, new_status,
                             actor_id, decision_id, operation_id, now)
        return self._explicit_record(self.db.execute(
            "SELECT * FROM explicit_memories WHERE id=?", (row["id"],)).fetchone())

    def _explicit_confirm(self, p: dict, operation_id: str) -> dict:
        self._explicit_keys(p, {"id", "scope", "expected_revision", "host_authorization"})
        return self._explicit_transition(p, operation_id, "confirmed", "confirmed")

    def _explicit_revise(self, p: dict, operation_id: str) -> dict:
        self._explicit_keys(p, {"id", "scope", "expected_revision", "content", "sources",
                                "host_authorization"})
        content = text(p["content"], "memory content", 4096)
        sources = self._explicit_sources(p["sources"])
        return self._explicit_transition(p, operation_id, "revised", "pending", content, sources)

    def _explicit_revoke(self, p: dict, operation_id: str) -> dict:
        self._explicit_keys(p, {"id", "scope", "expected_revision", "host_authorization"})
        return self._explicit_transition(p, operation_id, "revoked", "revoked")

    def explicit_get(self, memory_id: str, scope: str, revision: int | None = None) -> dict:
        row = self.db.execute("SELECT * FROM explicit_memories WHERE id=? AND scope=?",
                              (text(memory_id, "memory id", 256), text(scope, "scope", 1024))).fetchone()
        if row is None:
            raise MemoryError("Explicit memory not found in this scope.", "NOT_AVAILABLE")
        version = None
        if revision is not None:
            integer(revision, "revision", 1)
            version = self.db.execute(
                "SELECT * FROM explicit_memory_revisions WHERE memory_id=? AND revision=?",
                (row["id"], revision)).fetchone()
            if version is None:
                raise MemoryError("Explicit memory revision not found.", "NOT_AVAILABLE")
        return self._explicit_record(row, version)

    def explicit_search(self, scope: str, query: str, limit: int = 20) -> list[dict]:
        scope = text(scope, "scope", 1024)
        query = text(query, "query", 512)
        integer(limit, "limit", 1, 20)
        rows = self.db.execute(
            """SELECT m.*,r.content,r.sources,r.created_at AS revision_created_at
               FROM explicit_memories m JOIN explicit_memory_revisions r
                 ON r.memory_id=m.id AND r.revision=m.revision
               WHERE m.scope=? AND m.status='confirmed'
                 AND instr(lower(r.content),lower(?))>0
               ORDER BY m.updated_at DESC,m.id LIMIT ?""",
            (scope, query, limit)).fetchall()
        return [{
            "id": row["id"], "scope": row["scope"], "revision": row["revision"],
            "current_revision": row["revision"], "status": row["status"],
            "current_status": row["status"], "content": row["content"],
            "sources": json.loads(row["sources"]), "created_at": row["created_at"],
            "updated_at": row["updated_at"], "revision_created_at": row["revision_created_at"],
        } for row in rows]

    def explicit_audit(self, scope: str, memory_id: str, after: int = 0, limit: int = 50) -> dict:
        scope = text(scope, "scope", 1024)
        memory_id = text(memory_id, "memory id", 256)
        integer(after, "after")
        integer(limit, "limit", 1, 100)
        if not self.db.execute("SELECT 1 FROM explicit_memories WHERE id=? AND scope=?",
                               (memory_id, scope)).fetchone():
            raise MemoryError("Explicit memory not found in this scope.", "NOT_AVAILABLE")
        rows = [dict(row) for row in self.db.execute(
            """SELECT sequence,revision,action,status,actor,decision_id,operation_id,created_at
               FROM explicit_memory_events WHERE scope=? AND memory_id=? AND sequence>?
               ORDER BY sequence LIMIT ?""", (scope, memory_id, after, limit))]
        return {"events": rows, "next": rows[-1]["sequence"] if len(rows) == limit else None}

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
                self.db.execute("DELETE FROM piece_embeddings WHERE piece=?", (affected,))
            self._change("invalidated", affected)

    def _create(self, p: dict) -> dict:
        piece = text(p["piece"], "piece", 256)
        kind = p.get("kind", "piece")
        if kind not in KINDS:
            raise MemoryError("Unknown Piece kind.")
        scope = scope_text(p.get("scope", ""))
        self._assert_scope_live(scope)
        self.db.execute("INSERT INTO pieces(id,label,kind,scope) VALUES(?,?,?,?)",
                        (piece, text(p["label"], "label", 1024), kind, scope))
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
        with self._transaction(immediate=False):
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
            missing = not piece["evicted"] and bool(self.db.execute(
                "SELECT 1 FROM statements WHERE piece=? AND body IS NULL LIMIT 1", (piece_id,)).fetchone())
            if not piece["evicted"] and piece["kind"] == "message" and not self.db.execute(
                    "SELECT 1 FROM statements WHERE piece=? LIMIT 1", (piece_id,)).fetchone():
                missing = True
            return {"status": "evicted" if piece["evicted"] else "missing" if missing else "ready",
                    "piece": piece, "summary": dict(summary) if summary else None,
                    "summary_current": bool(summary and summary["input_revision"] == piece["revision"]),
                    "statements": rows, "next": rows[-1]["sequence"] if rows else after}

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
        if row["embedding"] is None:
            return {"piece": piece_id, "embedding": None, "status": "missing"}
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
        if self.db.execute("SELECT 1 FROM deleted_chats WHERE chat=?", (chat,)).fetchone():
            return {"removed_statements": 0}
        self.db.execute("INSERT INTO deleted_chats VALUES(?)", (chat,))
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
        # Topics with no extracted statements still carry private labels and turn inputs.
        owned = self.db.execute("SELECT id FROM pieces WHERE scope=?", (chat,)).fetchall()
        for piece in owned:
            piece_id = piece["id"]
            self._invalidate(piece_id, destructive=True)
            self.db.execute("DELETE FROM statements WHERE piece=?", (piece_id,))
            self.db.execute("DELETE FROM piece_embeddings WHERE piece=?", (piece_id,))
            self.db.execute("DELETE FROM leases WHERE piece=?", (piece_id,))
            self.db.execute("UPDATE pieces SET label='',evicted=1,bytes=0 WHERE id=?", (piece_id,))
        self.db.execute("DELETE FROM edges WHERE parent IN (SELECT id FROM pieces WHERE scope=?) "
                        "OR child IN (SELECT id FROM pieces WHERE scope=?)", (chat, chat))
        self.db.execute("DELETE FROM turns WHERE scope=?", (chat,))
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
        """Persist state without implicit retention, including scope focus and pending steps."""
        with self._transaction():
            self._assert_scope_live(scope)
            self.db.execute("INSERT OR REPLACE INTO turns VALUES(?,?,?,?)",
                            (text(turn_id, "turn", 256), scope, json.dumps(state, ensure_ascii=False), time.time()))

    def _assert_scope_live(self, scope: str) -> None:
        if self.db.execute("SELECT 1 FROM deleted_chats WHERE chat=?", (scope,)).fetchone():
            raise MemoryError("Memory scope was permanently deleted.")

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
