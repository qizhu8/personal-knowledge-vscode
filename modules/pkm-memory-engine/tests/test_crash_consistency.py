"""Failure injection for SQLite payloads and their projections (no external blob store)."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from pkm_memory_engine import Engine, Memory, MemoryError


class CrashConsistencyTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "memory.sqlite"
        self.engine = Engine(self.path, "identity")
        self.addCleanup(lambda: self.engine.close())
        self.memory = Memory(self.engine)

    def create(self, piece="p", kind="topic"):
        return self.engine.mutate("create:" + piece, "create",
                                  {"piece": piece, "label": piece, "scope": "chat", "kind": kind})

    def append(self, piece="p", statement="s", body="payload"):
        return self.engine.mutate("append:" + statement, "append", {
            "piece": piece, "statement_id": statement, "body": body,
            "expected_revision": self.engine._piece(piece)["revision"],
            "sources": [{"id": statement + ":source", "chat": "chat", "revision": "1", "locator": statement}]})

    def reopen(self):
        self.engine.close()
        self.engine = Engine(self.path, "identity")
        self.memory = Memory(self.engine)

    def counts(self):
        return {table: self.engine.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
                for table in ("pieces", "statements", "sources", "provenance", "edges", "operations", "changes", "turns")}

    def test_append_failure_rolls_back_payload_and_indexes(self):
        self.create()
        before = self.counts()
        with patch.object(self.engine, "_invalidate", side_effect=RuntimeError("injected")):
            with self.assertRaises(RuntimeError):
                self.append()
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.engine._piece("p")["bytes"], 0)
        self.append()
        self.assertEqual(len(self.engine.read("p")["statements"]), 1)

    def test_chunk_failure_does_not_leave_partial_message(self):
        original = self.engine._append
        def fail_second(params):
            result = original(params)
            if self.engine.db.execute("SELECT COUNT(*) FROM statements").fetchone()[0] == 2:
                raise RuntimeError("second chunk")
            return result
        before = self.counts()
        with patch.object(self.engine, "_append", side_effect=fail_second):
            with self.assertRaises(RuntimeError):
                self.memory.turn_commit("turn", {"id": "u", "text": "x" * 33000},
                                        {"id": "a", "text": "answer"}, scope="chat")
        self.assertEqual(self.counts(), before)
        self.reopen()
        self.memory.turn_commit("turn", {"id": "u", "text": "x" * 33000},
                                {"id": "a", "text": "answer"}, scope="chat")
        self.assertEqual("".join(s["body"] for s in self.engine.read("chat|m|u")["statements"]), "x" * 33000)

    def test_turn_state_failure_rolls_back_messages(self):
        before = self.counts()
        with patch.object(self.engine, "turn_put", side_effect=RuntimeError("state write")):
            with self.assertRaises(RuntimeError):
                self.memory.turn_commit("turn", {"id": "u", "text": "question"},
                                        {"id": "a", "text": "answer"}, scope="chat")
        self.assertEqual(self.counts(), before)

    def test_process_crash_between_sqlite_blob_write_and_commit(self):
        self.create()
        script = """import os, sys
from pkm_memory_engine import Engine
engine = Engine(sys.argv[1], 'identity')
engine.db.execute('BEGIN IMMEDIATE')
engine.db.execute("INSERT INTO statements VALUES('uncommitted','p',1,'blob','observation')")
os._exit(23)
"""
        result = subprocess.run([sys.executable, "-c", script, str(self.path)], check=False)
        self.assertEqual(result.returncode, 23)
        self.reopen()
        self.assertEqual(self.engine.read("p")["statements"], [])
        self.assertEqual(self.engine.db.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_open_reconciles_orphan_projections(self):
        self.engine.db.execute("PRAGMA foreign_keys=OFF")
        self.engine.db.execute("INSERT INTO summaries VALUES('orphan',0,'body','hash',0)")
        self.engine.db.execute("INSERT INTO edges VALUES('orphan','missing','abstracts')")
        self.engine.db.execute("INSERT INTO provenance VALUES('orphan','missing')")
        self.reopen()
        for table in ("summaries", "edges", "provenance"):
            self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.engine.capabilities()["reconciliation"]["removed_rows"], 3)
        self.reopen()
        self.assertEqual(self.engine.capabilities()["reconciliation"]["removed_rows"], 0)

    def test_missing_sqlite_payload_is_explicit(self):
        self.create(kind="message")
        self.append()
        self.engine.db.execute("UPDATE statements SET body=NULL WHERE id='s'")
        self.assertEqual(self.engine.read("p")["status"], "missing")
        missing = self.memory.memory_read("chat", "p")
        self.assertEqual(missing["status"], "missing")
        self.assertIn("statements", missing)
        self.assertIn("children", missing)
        self.assertEqual(self.engine._piece("p")["last_used"], 0)
        self.reopen()
        self.assertEqual(self.engine.read("p")["status"], "missing")

    def test_missing_embedding_blob_is_explicit(self):
        self.create()
        self.engine.db.execute("INSERT INTO piece_embeddings VALUES('p','summary',0,'h','space',2,'float32-le','cosine',NULL,'ready')")
        self.assertEqual(self.engine.embedding("p", "space")["status"], "missing")
        self.reopen()
        self.assertEqual(self.engine.embedding("p", "space")["status"], "missing")

    def test_delete_failure_rolls_back_all_projections(self):
        self.create()
        self.append()
        before = self.counts()
        with patch.object(self.engine, "_change", side_effect=RuntimeError("delete")):
            with self.assertRaises(RuntimeError):
                self.memory.forget_scope("chat")
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.engine.read("p")["statements"][0]["body"], "payload")

    def test_delete_and_retention_are_idempotent(self):
        self.create()
        self.append()
        self.memory.forget_scope("chat")
        revision = self.engine._piece("p")["revision"]
        self.engine.mutate("another-delete", "purge_chat", {"chat": "chat"})
        self.assertEqual(self.engine._piece("p")["revision"], revision)
        for table in ("statements", "provenance", "summaries", "piece_embeddings", "edges", "turns"):
            self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.memory.enforce_capacity(0)["evicted"], [])

    def test_capacity_does_not_replay_a_previous_eviction(self):
        self.create("first")
        self.append("first", "first")
        self.memory.enforce_capacity(0)
        self.create("second")
        self.append("second", "second")
        self.assertEqual(self.memory.enforce_capacity(0)["usage"]["bytes"], 0)
        self.assertEqual(self.memory.enforce_capacity(0)["evicted"], [])

    def test_retention_failure_rolls_back(self):
        self.create()
        self.append()
        with patch.object(self.engine, "_change", side_effect=RuntimeError("eviction")):
            with self.assertRaises(RuntimeError):
                self.memory.enforce_capacity(0)
        self.assertEqual(self.engine.read("p")["statements"][0]["body"], "payload")

    def test_failed_extraction_leaves_no_partial_statements(self):
        self.create()
        state = {"turn": "turn", "scope": "chat", "phase": "extract",
                 "calls": [{"purpose": "extract"}], "pending": {"purpose": "extract"},
                 "extract_aliases": {"T1": "p"}, "summaries": [],
                 "sources": [{"id": "src", "chat": "chat", "revision": "1", "locator": "loc"}]}
        self.engine.turn_put("turn", "chat", state)
        original = self.engine._append
        def fail_second(params):
            result = original(params)
            if self.engine.db.execute("SELECT COUNT(*) FROM statements").fetchone()[0] == 2:
                raise MemoryError("invalid second item")
            return result
        with patch.object(self.engine, "_append", side_effect=fail_second):
            self.memory.turn_continue("turn", output=json.dumps({"statements": [
                {"topic": "T1", "text": "one"}, {"topic": "T1", "text": "two"}]}))
        self.assertEqual(self.engine.read("p")["statements"], [])
        self.assertEqual(self.engine.turn_get("turn")["extract"]["added"], [])

    def test_failed_intent_creation_rolls_back_before_fallback(self):
        self.memory.turn_begin("chat", "turn", {"id": "u", "text": "question"})
        self.memory.turn_continue("turn", output=json.dumps({
            "new": [{"key": "new:1", "label": "orphan topic"}], "focus": ["unknown"]}))
        self.assertEqual([p["label"] for p in self.engine.pieces("chat", "topic")], ["question"])
        state = self.engine.turn_get("turn")
        self.assertEqual(state["intent"]["status"], "fallback")
        self.assertEqual(state["intent"]["created"], [])

    def age_turns(self):
        self.engine.db.execute("UPDATE turns SET updated=?", (time.time() - 8 * 86400,))

    def save_scope_focus(self):
        self.create()
        state = {"turn": self.memory._state_key("chat"), "scope": "chat", "focus": ["p"]}
        self.engine.turn_put(state["turn"], "chat", state)
        return state

    def test_reconcile_preserves_aged_scope_focus(self):
        state = self.save_scope_focus()
        self.age_turns()
        self.reopen()
        self.assertEqual(self.memory._scope_state("chat"), state)
        self.assertEqual(self.engine.capabilities()["reconciliation"]["removed_rows"], 0)
        self.reopen()
        self.assertEqual(self.memory._scope_state("chat"), state)

    def test_reconcile_preserves_aged_pending_turn(self):
        self.memory.turn_begin("chat", "pending", {"id": "u", "text": "question"})
        state = self.engine.turn_get("pending")
        self.age_turns()
        self.reopen()
        self.assertEqual(self.engine.turn_get("pending"), state)
        result = self.memory.turn_continue("pending", output=json.dumps({
            "new": [{"key": "new:1", "label": "topic"}], "focus": ["new:1"]}))
        self.assertEqual(result["status"], "ready")

    def test_turn_put_preserves_aged_scope_focus(self):
        state = self.save_scope_focus()
        self.age_turns()
        self.engine.turn_put("other", "other-chat", {"turn": "other", "phase": "done"})
        self.assertEqual(self.memory._scope_state("chat"), state)

    def test_turn_put_preserves_aged_pending_turn(self):
        self.memory.turn_begin("chat", "pending", {"id": "u", "text": "question"})
        state = self.engine.turn_get("pending")
        self.age_turns()
        self.engine.turn_put("other", "other-chat", {"turn": "other", "phase": "done"})
        self.assertEqual(self.engine.turn_get("pending"), state)
        self.assertEqual(self.memory.turn_continue("pending", error="model unavailable")["status"], "ready")

    def test_terminal_turn_requires_explicit_retention(self):
        state = {"turn": "old", "phase": "done"}
        self.engine.turn_put("old", "chat", state)
        self.age_turns()
        self.reopen()
        self.assertEqual(self.engine.turn_get("old"), state)
        self.assertEqual(self.engine.capabilities()["reconciliation"]["removed_rows"], 0)
        self.engine.turn_put("other", "other-chat", {"turn": "other", "phase": "done"})
        self.assertEqual(self.engine.turn_get("old"), state)

    def test_process_crash_after_embedding_blob_write(self):
        self.create()
        summary = self.engine.mutate("summary", "summary_commit", {
            "piece": "p", "expected_revision": 0, "body": "summary"})
        script = """import os, sys
from unittest.mock import patch
from pkm_memory_engine import Engine
engine = Engine(sys.argv[1], 'identity')
with patch.object(engine, '_change', side_effect=lambda *_: os._exit(24)):
    engine.mutate('embedding', 'embedding_put', {
        'piece': 'p', 'revision': 0, 'representation': 'summary',
        'input_content_hash': sys.argv[2], 'embedding_space_id': 'space',
        'dimensions': 2, 'distance_metric': 'cosine', 'embedding': [0.5, 1.0]})
"""
        result = subprocess.run([sys.executable, "-c", script, str(self.path), summary["content_hash"]], check=False)
        self.assertEqual(result.returncode, 24)
        self.reopen()
        self.assertEqual(self.engine.embedding("p", "space")["status"], "unavailable")
        self.assertIsNone(self.engine.db.execute("SELECT 1 FROM operations WHERE id='embedding'").fetchone())
        self.assertTrue(self.engine.read("p")["summary_current"])

    def run_external(self, script, *arguments, expected_exit=0):
        result = subprocess.run(
            [sys.executable, "-c", "import json, os, sys\nfrom pkm_memory_engine import Engine, Memory, MemoryError\n"
             "engine = Engine(sys.argv[1], 'identity')\n" + script, str(self.path), *arguments],
            check=False, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, expected_exit, result.stderr)
        return json.loads(result.stdout) if result.stdout else None

    def external_append(self, operation="external", revision=1, crash=False):
        return self.run_external(
            "result = engine.mutate(sys.argv[2], 'append', json.loads(sys.argv[3]))\n"
            + ("os._exit(25)\n" if crash else "print(json.dumps(result))\nengine.close()\n"),
            operation, json.dumps({
                "piece": "p", "statement_id": "external-statement", "body": "new process evidence",
                "expected_revision": revision,
                "sources": [{"id": "external-source", "chat": "chat", "revision": "2", "locator": "external"}]}),
            expected_exit=25 if crash else 0)

    def test_other_process_commit_invalidates_open_reader_summary_embedding_and_changes(self):
        self.create()
        self.append()
        summary = self.engine.mutate("summary", "summary_commit", {
            "piece": "p", "expected_revision": 1, "body": "old summary"})
        self.engine.mutate("embedding", "embedding_put", {
            "piece": "p", "revision": 1, "representation": "summary",
            "input_content_hash": summary["content_hash"], "embedding_space_id": "space",
            "dimensions": 2, "distance_metric": "cosine", "embedding": [0.5, 1.0]})
        self.assertEqual(self.engine.embedding("p", "space")["status"], "ready")
        cursor = self.engine.changes()[-1]["sequence"]
        self.external_append()
        current = self.engine.read("p")
        self.assertEqual(current["piece"]["revision"], 2)
        self.assertEqual([row["body"] for row in current["statements"]], ["payload", "new process evidence"])
        self.assertFalse(current["summary_current"])
        self.assertEqual(self.engine.embedding("p", "space")["status"], "unavailable")
        self.assertTrue(any(change["kind"] == "invalidated" and change["piece"] == "p"
                            for change in self.engine.changes(cursor)))
        self.reopen()
        self.assertEqual(self.engine.read("p"), current)

    def test_other_process_deletion_is_visible_without_reader_restart_and_cannot_resurrect(self):
        self.create()
        self.append()
        self.engine.turn_put("pending", "chat", {"turn": "pending", "phase": "extract"})
        self.run_external("Memory(engine).forget_scope('chat')\nengine.close()\n")
        self.assertEqual(self.engine.read("p")["status"], "evicted")
        self.assertEqual(self.engine.read("p")["statements"], [])
        self.assertEqual(self.engine.sources("s"), [])
        self.assertIsNone(self.engine.turn_get("pending"))
        with self.assertRaisesRegex(MemoryError, "permanently deleted"):
            self.create("resurrect")
        result = self.run_external(
            "try:\n"
            "    engine.mutate('recreate', 'create', {'piece':'other', 'label':'other', 'scope':'chat'})\n"
            "except MemoryError as error:\n"
            "    print(json.dumps({'error': str(error)}))\n"
            "else:\n"
            "    raise AssertionError('Deleted scope was resurrected')\n")
        self.assertIn("permanently deleted", result["error"])
        self.reopen()
        self.assertEqual(self.engine.read("p")["status"], "evicted")
        self.assertIsNone(self.engine.turn_get("pending"))

    def test_competing_processes_compare_and_swap_one_revision_without_partial_loser(self):
        self.create()
        script = """import json, sys
from pkm_memory_engine import Engine, MemoryError
engine = Engine(sys.argv[1], 'identity')
name = sys.argv[2]
try:
    result = engine.mutate(name, 'append', {
        'piece':'p', 'statement_id':name, 'body':name, 'expected_revision':0,
        'sources':[{'id':name + ':source', 'chat':'chat', 'revision':'1', 'locator':name}]})
except MemoryError as error:
    print(json.dumps({'status':'rejected', 'error':str(error), 'id':name}))
else:
    print(json.dumps({'status':'committed', 'result':result, 'id':name}))
finally:
    engine.close()
"""
        processes = []
        try:
            for name in ("writer-one", "writer-two"):
                processes.append(subprocess.Popen(
                    [sys.executable, "-c", script, str(self.path), name],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8"))
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, stderr)
                results.append(json.loads(stdout))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
        committed = [result for result in results if result["status"] == "committed"]
        rejected = [result for result in results if result["status"] == "rejected"]
        self.assertEqual(len(committed), 1, results)
        self.assertEqual(len(rejected), 1, results)
        self.assertIn("Stale Piece revision", rejected[0]["error"])
        state = self.engine.read("p")
        self.assertEqual(state["piece"]["revision"], 1)
        self.assertEqual([row["id"] for row in state["statements"]], [committed[0]["id"]])
        self.assertIsNone(self.engine.db.execute(
            "SELECT 1 FROM operations WHERE id=?", (rejected[0]["id"],)).fetchone())
        self.assertIsNone(self.engine.db.execute(
            "SELECT 1 FROM sources WHERE id=?", (rejected[0]["id"] + ":source",)).fetchone())
        self.assertEqual(self.engine.db.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_process_exit_after_commit_replays_exact_operation_once(self):
        self.create()
        self.append()
        self.assertIsNone(self.external_append(crash=True))
        result = self.external_append()
        self.reopen()
        self.assertEqual(self.external_append(), result)
        state = self.engine.read("p")
        self.assertEqual(state["piece"]["revision"], 2)
        self.assertEqual(len(state["statements"]), 2)

    def test_reader_snapshot_is_coherent_when_other_process_commits_mid_read(self):
        self.create()
        self.append()
        before = self.engine.read("p")
        original = self.engine._piece
        def commit_after_piece_read(piece_id):
            piece = original(piece_id)
            self.external_append()
            return piece
        with patch.object(self.engine, "_piece", side_effect=commit_after_piece_read):
            snapshot = self.engine.read("p")
        self.assertEqual(snapshot, before)
        current = self.engine.read("p")
        self.assertEqual(current["piece"]["revision"], 2)
        self.assertEqual(len(current["statements"]), 2)

    def test_commit_failure_rolls_back(self):
        self.create()
        before = self.counts()
        self.engine.db.set_authorizer(lambda action, arg, *_: sqlite3.SQLITE_DENY
                                     if action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT"
                                     else sqlite3.SQLITE_OK)
        try:
            with self.assertRaises(sqlite3.DatabaseError):
                self.append()
        finally:
            self.engine.db.set_authorizer(None)
        self.assertFalse(self.engine.db.in_transaction)
        self.assertEqual(self.counts(), before)


if __name__ == "__main__":
    unittest.main()
