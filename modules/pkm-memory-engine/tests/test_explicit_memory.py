import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from pkm_memory_engine import Engine, MemoryError


class ExplicitMemoryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "memory.sqlite3"
        self.engine = Engine(self.database, "account/root")
        self.scope = json.dumps(
            {"account": "acct-1", "project": "project-1", "repository": "repo-1"},
            separators=(",", ":"),
        )
        self.sources = [{
            "id": "source-1", "chat": "pkm://chats/chat-1",
            "revision": "turn-3", "locator": "message#user-3:12-42",
        }]

    def tearDown(self):
        self.engine.close()
        self.directory.cleanup()

    def propose(self, operation_id="propose-1", **extra):
        return self.engine.mutate(operation_id, "explicit_propose", {
            "id": "record-1", "scope": self.scope,
            "content": "Use SQLite for durable memory.", "sources": self.sources, **extra,
        })

    def authorize(self, action, revision, operation_id):
        return self.engine.mutate(operation_id, f"explicit_{action}", {
            "id": "record-1", "scope": self.scope, "expected_revision": revision,
            "host_authorization": {"decision_id": f"host-{operation_id}", "actor_id": "native-user-1"},
        })

    def test_revision_cas_audit_and_revocation_survive_restart(self):
        pending = self.propose()
        self.assertEqual(pending["status"], "pending")
        self.assertEqual(pending["revision"], 1)
        self.assertEqual(pending["sources"], self.sources)
        self.assertEqual(self.engine.explicit_search(self.scope, "sqlite"), [])
        self.assertEqual(self.propose(), pending)

        confirmed = self.authorize("confirm", 1, "confirm-1")
        self.assertEqual((confirmed["revision"], confirmed["status"]), (2, "confirmed"))
        with self.assertRaisesRegex(MemoryError, "Stale"):
            self.authorize("revoke", 1, "stale-revoke")
        self.assertEqual(self.engine.explicit_search(self.scope, "sqlite")[0]["id"], "record-1")
        self.assertEqual(self.engine.explicit_get("record-1", self.scope, 1)["status"], "superseded")

        revised = self.engine.mutate("revise-1", "explicit_revise", {
            "id": "record-1", "scope": self.scope, "expected_revision": 2,
            "content": "Use SQLite WAL for durable memory.",
            "sources": self.sources,
            "host_authorization": {"decision_id": "host-revise", "actor_id": "native-user-1"},
        })
        self.assertEqual((revised["revision"], revised["status"]), (3, "pending"))
        self.assertEqual(self.engine.explicit_search(self.scope, "sqlite"), [])
        confirmed_again = self.authorize("confirm", 3, "confirm-2")
        self.assertEqual((confirmed_again["revision"], confirmed_again["status"]), (4, "confirmed"))
        revoked = self.authorize("revoke", 4, "revoke-1")
        self.assertEqual((revoked["revision"], revoked["status"]), (5, "revoked"))
        self.assertEqual(self.engine.explicit_search(self.scope, "sqlite"), [])

        audit = self.engine.explicit_audit(self.scope, "record-1")["events"]
        self.assertEqual([event["action"] for event in audit],
                         ["proposed", "confirmed", "revised", "confirmed", "revoked"])
        self.assertEqual(audit[1]["decision_id"], "host-confirm-1")
        self.assertEqual(audit[0]["actor"], "caller")
        self.assertEqual(audit[1]["actor"], "native-user-1")
        self.engine.close()
        self.engine = Engine(self.database, "account/root")
        self.assertEqual(self.engine.explicit_get("record-1", self.scope)["status"], "revoked")
        self.assertEqual(self.engine.explicit_search(self.scope, "sqlite"), [])

    def test_proposal_rejects_model_confirmed_fields_and_invalid_bounds(self):
        with self.assertRaisesRegex(MemoryError, "exactly these explicit-memory fields"):
            self.propose(operation_id="model-claim", status="confirmed")
        with self.assertRaisesRegex(MemoryError, "exactly these explicit-memory fields"):
            self.propose(operation_id="model-claim-2", confirmed=True)
        with self.assertRaisesRegex(MemoryError, "Host-authorized"):
            self.engine.mutate("no-host", "explicit_confirm", {
                "id": "record-1", "scope": self.scope, "expected_revision": 1,
                "host_authorization": {},
            })
        with self.assertRaisesRegex(MemoryError, "4096 bytes"):
            self.engine.mutate("too-long", "explicit_propose", {
                "id": "large", "scope": self.scope, "content": "x" * 4097, "sources": self.sources,
            })
        with self.assertRaisesRegex(MemoryError, "1..32"):
            self.engine.mutate("no-source", "explicit_propose", {
                "id": "no-source", "scope": self.scope, "content": "Durable note.", "sources": [],
            })
        with self.assertRaisesRegex(MemoryError, "\\[1, 20\\]"):
            self.engine.explicit_search(self.scope, "note", 21)

    def test_source_reference_aggregate_limit_applies_to_propose_and_revise(self):
        long_sources = [
            {"id": f"source-{index}", "chat": "pkm://chats/chat-1", "revision": "turn-3",
             "locator": "x" * 1500}
            for index in range(3)
        ]
        with self.assertRaisesRegex(MemoryError, "exceed 4096 UTF-8 bytes in total"):
            self.engine.mutate("oversized-proposal", "explicit_propose", {
                "id": "large-sources", "scope": self.scope,
                "content": "Durable note.", "sources": long_sources,
            })
        self.propose()
        with self.assertRaisesRegex(MemoryError, "exceed 4096 UTF-8 bytes in total"):
            self.engine.mutate("oversized-revision", "explicit_revise", {
                "id": "record-1", "scope": self.scope, "expected_revision": 1,
                "content": "Updated note.", "sources": long_sources,
                "host_authorization": {"decision_id": "host-revise", "actor_id": "native-user-1"},
            })

    def test_schema_one_database_migrates_in_place_to_schema_two(self):
        self.engine.mutate("legacy-create", "create", {"piece": "legacy", "label": "Legacy"})
        self.engine.close()
        connection = sqlite3.connect(self.database)
        try:
            for name in ("explicit_memory_scope_status", "explicit_memory_audit",
                         "explicit_memory_events", "explicit_memory_revisions", "explicit_memories"):
                connection.execute(f"DROP INDEX IF EXISTS {name}")
                connection.execute(f"DROP TABLE IF EXISTS {name}")
            connection.execute("PRAGMA user_version=1")
            connection.commit()
        finally:
            connection.close()

        self.engine = Engine(self.database, "account/root")
        self.assertEqual(self.engine.db.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual(self.engine.read("legacy")["piece"]["id"], "legacy")
        self.assertEqual(self.engine.db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='explicit_memories'"
        ).fetchone()[0], 1)
        self.assertEqual(self.engine.explicit_search(self.scope, "none"), [])

    def test_worker_dispatches_explicit_protocol_and_scope_isolation(self):
        self.engine.close()
        requests = [
            {"protocol": 1, "id": "p", "method": "explicit_propose", "operation_id": "worker-propose",
             "params": {"id": "worker-record", "scope": self.scope,
                        "content": "worker durable note", "sources": self.sources}},
            {"protocol": 1, "id": "c", "method": "explicit_confirm", "operation_id": "worker-confirm",
             "params": {"id": "worker-record", "scope": self.scope, "expected_revision": 1,
                        "host_authorization": {"decision_id": "host-worker", "actor_id": "native-user-1"}}},
            {"protocol": 1, "id": "s", "method": "explicit_search",
             "params": {"scope": self.scope, "query": "worker"}},
            {"protocol": 1, "id": "wrong", "method": "explicit_search",
             "params": {"scope": "other-scope", "query": "worker"}},
        ]
        process = subprocess.run(
            [sys.executable, "-m", "pkm_memory_engine", "--database", str(self.database), "--identity", "account/root"],
            input="".join(json.dumps(request) + "\n" for request in requests),
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertTrue(all(response["ok"] for response in responses), responses)
        self.assertEqual(responses[0]["result"]["status"], "pending")
        self.assertEqual(responses[1]["result"]["status"], "confirmed")
        self.assertEqual([row["id"] for row in responses[2]["result"]], ["worker-record"])
        self.assertEqual(responses[3]["result"], [])
        self.engine = Engine(self.database, "account/root")


if __name__ == "__main__":
    unittest.main()
