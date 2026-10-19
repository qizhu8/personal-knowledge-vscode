import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from pkm_memory_engine import Engine, MemoryError


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-memory-test-")
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "memory.sqlite3"
        self.engine = Engine(self.database, "test-account/root")
        self.addCleanup(self.engine.close)
        self.operation = 0

    def mutate(self, method, **params):
        self.operation += 1
        return self.engine.mutate(f"op-{self.operation}", method, params)

    def create(self, piece):
        return self.mutate("create", piece=piece, label=piece)

    def append(self, piece, body, chat="chat-a", statement=None):
        revision = self.engine.read(piece)["piece"]["revision"]
        return self.mutate("append", piece=piece, body=body,
                           statement_id=statement or f"statement-{self.operation}",
                           expected_revision=revision,
                           sources=[{"id": f"source-{self.operation}", "chat": chat,
                                     "revision": "sha256-original",
                                     "locator": f"{chat}/message-1#utf16:0:20"}])

    def summarize(self, piece, body):
        return self.mutate("summary_commit", piece=piece, body=body,
                           expected_revision=self.engine.read(piece)["piece"]["revision"])

    def test_real_wal_persistence_and_partition(self):
        self.create("problem")
        self.append("problem", "A detailed problem")
        other = Engine(self.database, "test-account/root")
        try:
            self.assertEqual(other.read("problem")["statements"][0]["body"], "A detailed problem")
            self.assertEqual(other.db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(other.db.execute("PRAGMA synchronous").fetchone()[0], 2)
            self.assertEqual(other.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            other.close()
        with self.assertRaisesRegex(MemoryError, "identity mismatch"):
            Engine(self.database, "another-account")

    def test_idempotence_conflict_and_transaction_rollback(self):
        params = {"piece": "p", "label": "P"}
        first = self.engine.mutate("stable", "create", params)
        self.assertEqual(first, self.engine.mutate("stable", "create", params))
        with self.assertRaisesRegex(MemoryError, "reused"):
            self.engine.mutate("stable", "create", {"piece": "q", "label": "Q"})
        with self.assertRaisesRegex(MemoryError, "source"):
            self.mutate("append", piece="p", statement_id="bad", body="Must roll back",
                        expected_revision=0, sources=[])
        self.assertEqual(self.engine.read("p")["statements"], [])
        self.assertEqual(self.engine.read("p")["piece"]["revision"], 0)

    def test_multiple_parents_cycle_and_levels(self):
        for piece in ["root", "design", "retrieval", "detail"]:
            self.create(piece)
        for parent, child in [("root", "design"), ("design", "detail"), ("retrieval", "detail")]:
            self.mutate("link", parent=parent, child=child, relation="abstracts")
        self.assertEqual(self.engine.read("root")["piece"]["level"], 2)
        self.assertEqual(len(self.engine.neighbors("detail")), 2)
        with self.assertRaisesRegex(MemoryError, "cycle"):
            self.mutate("link", parent="detail", child="root", relation="abstracts")
        self.assertEqual(self.engine.read("root")["piece"]["level"], 2)

    def test_append_only_contradictions_and_lazy_summary(self):
        self.create("p")
        self.append("p", "Initial explanation is X")
        self.assertIsNone(self.engine.read("p")["summary"])
        self.summarize("p", "X is a proposal")
        self.assertTrue(self.engine.read("p")["summary_current"])
        self.append("p", "Later evidence contradicts X")
        state = self.engine.read("p")
        self.assertEqual(len(state["statements"]), 2)
        self.assertFalse(state["summary_current"])
        self.assertEqual(state["summary"]["body"], "X is a proposal")
        self.assertTrue(self.engine.sources(state["statements"][0]["id"])[0]["locator"])
        self.summarize("p", "X is disputed by later evidence")
        self.assertTrue(self.engine.read("p")["summary_current"])
        with self.assertRaisesRegex(MemoryError, "immutable"):
            self.summarize("p", "Silently different summary")

    def test_late_summary_and_embedding_rejected(self):
        self.create("p")
        old = self.append("p", "Old")
        self.append("p", "New")
        with self.assertRaisesRegex(MemoryError, "changed"):
            self.mutate("summary_commit", piece="p", expected_revision=old["revision"], body="Old summary")
        summary = self.summarize("p", "Current")
        params = dict(piece="p", revision=summary["revision"], representation="summary",
                      input_content_hash=summary["content_hash"], embedding_space_id="model-a:v1",
                      dimensions=2, distance_metric="cosine", embedding=[0.5, 1.0])
        self.assertIsNone(self.engine.embedding("p", "model-a:v1")["embedding"])
        self.mutate("embedding_put", **params)
        self.assertEqual(self.engine.embedding("p", "model-a:v1")["embedding"], [0.5, 1.0])
        self.mutate("embedding_put", **{**params, "embedding_space_id": "model-b:v1"})
        self.assertIsNotNone(self.engine.embedding("p", "model-b:v1")["embedding"])
        for bad in ([1.0], [0.0, 0.0], [float("inf"), 1.0], [True, 1.0]):
            with self.assertRaises((MemoryError, ValueError)):
                self.mutate("embedding_put", **{**params, "embedding": bad})
        self.append("p", "Changed")
        self.assertIsNone(self.engine.embedding("p", "model-a:v1")["embedding"])
        with self.assertRaisesRegex(MemoryError, "current"):
            self.mutate("embedding_put", **params)

    def test_child_revision_invalidates_ancestor(self):
        for piece in ("parent", "child"):
            self.create(piece)
        self.mutate("link", parent="parent", child="child", relation="abstracts")
        self.append("child", "Evidence")
        self.summarize("parent", "High-level conclusion")
        self.assertTrue(self.engine.read("parent")["summary_current"])
        self.append("child", "New condition")
        self.assertFalse(self.engine.read("parent")["summary_current"])

    def test_low_level_first_lru_and_no_parent_refresh(self):
        for piece in ("parent", "old-leaf", "new-leaf"):
            self.create(piece)
        self.mutate("link", parent="parent", child="old-leaf", relation="abstracts")
        self.summarize("parent", "Retained abstraction")
        self.mutate("touch", piece="old-leaf", reason="read")
        self.mutate("touch", piece="new-leaf", reason="sent")
        self.mutate("touch", piece="parent", reason="read")
        for _ in range(3):
            self.engine.read("old-leaf")
        self.assertEqual(self.mutate("evict", count=1)["evicted"], ["old-leaf"])
        self.assertTrue(self.engine.read("parent")["summary_current"])
        self.assertEqual(self.mutate("evict", count=1, protected=["new-leaf"])["evicted"], ["parent"])
        self.assertTrue(self.mutate("evict", count=1, protected=["new-leaf"])["pressure"])
        with self.assertRaisesRegex(MemoryError, "meaningful"):
            self.mutate("touch", piece="new-leaf", reason="candidate")

    def test_shared_source_purge_and_no_resurrection(self):
        for piece in ("parent", "shared"):
            self.create(piece)
        self.mutate("link", parent="parent", child="shared", relation="abstracts")
        self.append("shared", "Private A", chat="chat-a")
        self.append("shared", "Independent B", chat="chat-b")
        self.summarize("shared", "A plus B")
        self.summarize("parent", "Derived A plus B")
        self.assertEqual(self.mutate("purge_chat", chat="chat-a")["removed_statements"], 1)
        state = self.engine.read("shared")
        self.assertEqual([s["body"] for s in state["statements"]], ["Independent B"])
        self.assertIsNone(state["summary"])
        self.assertIsNone(self.engine.read("parent")["summary"])
        with self.assertRaisesRegex(MemoryError, "deleted"):
            self.append("shared", "Resurrection with another source ID", chat="chat-a")
        self.assertEqual(len(self.engine.read("shared")["statements"]), 1)

    def test_durable_leases_exclude_live_readers_from_eviction(self):
        self.create("p")
        self.mutate("lease_acquire", piece="p", lease_id="request-1", ttl_seconds=120,
                    expected_revision=0)
        other = Engine(self.database, "test-account/root")
        try:
            result = other.mutate("reclaim", "evict", {"count": 1})
            self.assertEqual(result["evicted"], [])
            self.assertTrue(result["pressure"])
        finally:
            other.close()
        self.mutate("lease_release", lease_id="request-1")
        self.assertEqual(self.mutate("evict", count=1)["evicted"], ["p"])

    def test_large_unicode_pages_stay_bounded_and_make_progress(self):
        self.create("p")
        for _ in range(8):
            self.append("p", "知" * 21000)
        self.summarize("p", "摘要" * 5000)
        page = self.engine.read("p")
        self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 256 * 1024)
        self.assertGreater(page["next"], 0)
        self.assertLess(len(page["statements"]), 8)
        self.assertTrue(self.engine.read("p", after=page["next"])["statements"])

    def test_pagination_and_backup(self):
        self.create("p")
        for i in range(7):
            self.append("p", f"statement {i}")
        page1 = self.engine.read("p", limit=3)
        page2 = self.engine.read("p", after=page1["next"], limit=3)
        self.assertEqual([s["sequence"] for s in page2["statements"]], [4, 5, 6])
        backup = self.database.with_name("backup.sqlite3")
        self.engine.backup(backup)
        restored = Engine(backup, "test-account/root")
        try:
            self.assertEqual(len(restored.read("p")["statements"]), 7)
        finally:
            restored.close()
        with self.assertRaisesRegex(MemoryError, "already"):
            self.engine.backup(backup)

    def test_newer_schema_not_replaced(self):
        other = self.database.with_name("future.sqlite3")
        connection = sqlite3.connect(other)
        connection.execute("PRAGMA user_version=100")
        connection.close()
        with self.assertRaisesRegex(MemoryError, "Unsupported"):
            Engine(other, "test-account/root")
        connection = sqlite3.connect(other)
        self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 100)
        connection.close()

    def test_real_process_contention_and_interrupted_transaction(self):
        script = """
import sys
from pkm_memory_engine import Engine
e = Engine(sys.argv[1], 'test-account/root')
for i in range(25):
    name = sys.argv[2] + str(i)
    e.mutate(name, 'create', {'piece':name,'label':name})
e.close()
"""
        processes = [subprocess.Popen([sys.executable, "-c", script, str(self.database), f"worker{i}-"],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(4)]
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, (stdout, stderr))
        self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM pieces").fetchone()[0], 100)
        crash = """import sqlite3,os,sys
c=sqlite3.connect(sys.argv[1]);c.execute('BEGIN IMMEDIATE')
c.execute("INSERT INTO pieces(id,label) VALUES('uncommitted','No')")
os._exit(23)
"""
        result = subprocess.run([sys.executable, "-c", crash, str(self.database)], timeout=10)
        self.assertEqual(result.returncode, 23)
        with self.assertRaisesRegex(MemoryError, "not found"):
            self.engine.read("uncommitted")
        self.assertEqual(self.engine.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_stdio_errors_are_explicit_and_worker_continues(self):
        requests = ['not json', json.dumps({"protocol": 2, "method": "capabilities"}),
                    json.dumps({"id": "ready", "protocol": 1, "method": "capabilities"}),
                    json.dumps({"id": "create", "protocol": 1, "method": "create",
                                "operation_id": "stdio-create", "params": {"piece": "stdio", "label": "Stdio"}}),
                    json.dumps({"id": "read", "protocol": 1, "method": "read",
                                "params": {"piece_id": "stdio"}})]
        result = subprocess.run([sys.executable, "-m", "pkm_memory_engine", "--database",
                                 str(self.database), "--identity", "test-account/root"],
                                input="\n".join(requests) + "\n", capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["ok"] for r in replies], [False, False, True, True, True])
        self.assertEqual(replies[-1]["result"]["piece"]["id"], "stdio")
        self.assertEqual(replies[2]["result"]["schema"], 1)


if __name__ == "__main__":
    unittest.main()
