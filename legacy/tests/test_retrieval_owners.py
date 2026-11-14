import os
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from retrieval_drain import DrainAdmission
from retrieval_owners import RetrievalOwners
from retrieval_mcp_owner import McpRetrievalOwner


class RetrievalOwnerTests(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ["PKM_RETRIEVAL_TEST_WORK"]).resolve()
        self.state = root / ("retrieval-owner-test-" + str(uuid.uuid4()))
        self.state.mkdir(mode=0o700)

    def test_shared_last_close_and_uncompleted_crash_are_preserved(self):
        owners = RetrievalOwners(self.state)
        admission = DrainAdmission()
        first, second, crashed = (str(uuid.uuid4()) for _ in range(3))
        host = str(uuid.uuid4())
        proof = "a" * 64
        stat = Path("/proc/self/stat").read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        owners.open(first, host, os.getpid(), start, proof, admission.accepting)
        owners.open(second, host, os.getpid(), start, proof, admission.accepting)
        with self.assertRaises(ValueError):
            owners.close(first, "b" * 64, admission.drain)
        self.assertEqual(owners.close(first, proof, admission.drain), {"remaining": 1, "shutdown": False, "unknown": False})
        self.assertTrue(admission.accepting())
        owners.open(crashed, host, os.getpid(), "1", proof, admission.accepting)
        self.assertEqual(owners.close(second, proof, admission.drain), {"remaining": 1, "shutdown": False, "unknown": True})
        self.assertTrue(admission.accepting())
        self.assertEqual(RetrievalOwners(self.state).pending(), 1)
        self.assertTrue((self.state / "owners" / (crashed + ".open")).exists())
        self.assertFalse((self.state / "owners" / (crashed + ".close")).exists())

    def test_last_close_rejects_late_admission(self):
        owners = RetrievalOwners(self.state)
        admission = DrainAdmission()
        first, late, host = (str(uuid.uuid4()) for _ in range(3))
        proof = "a" * 64
        owners.open(first, host, os.getpid(), "1", proof, admission.accepting)
        self.assertEqual(owners.close(first, proof, admission.drain), {"remaining": 0, "shutdown": True, "unknown": False})
        self.assertFalse(admission.accepting())
        with self.assertRaisesRegex(ValueError, "draining"):
            owners.open(late, host, os.getpid(), "1", proof, admission.accepting)

    def test_worker_crash_remains_unknown_after_restart(self):
        first = RetrievalOwners(self.state)
        first.begin_runtime()
        second = RetrievalOwners(self.state)
        second.begin_runtime()
        admission = DrainAdmission()
        owner, host = str(uuid.uuid4()), str(uuid.uuid4())
        proof = "a" * 64
        second.open(owner, host, os.getpid(), "1", proof, admission.accepting)
        self.assertEqual(second.close(owner, proof, admission.drain), {"remaining": 0, "shutdown": False, "unknown": True})
        self.assertTrue(admission.accepting())

    def test_idle_mcp_can_close_without_a_worker(self):
        owner = McpRetrievalOwner(self.state)
        self.assertEqual(owner.close(), "unused")
        self.assertEqual(owner.registry.pending(), 0)

    def test_runtime_drain_blocks_an_independent_mcp_admission(self):
        owners = RetrievalOwners(self.state)
        owners.begin_runtime()
        admission = DrainAdmission()
        owner, host = str(uuid.uuid4()), str(uuid.uuid4())
        proof = "a" * 64
        stat = Path("/proc/self/stat").read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        owners.open(owner, host, os.getpid(), start, proof, admission.accepting)
        self.assertTrue(owners.close(owner, proof, admission.drain)["shutdown"])
        with self.assertRaisesRegex(ValueError, "draining"):
            McpRetrievalOwner(self.state)
        owners.finish_runtime()
        later = McpRetrievalOwner(self.state)
        self.assertEqual(later.close(), "unused")

    def test_idle_mcp_does_not_close_a_crashed_runtime(self):
        owners = RetrievalOwners(self.state)
        owners.begin_runtime()
        owner = McpRetrievalOwner(self.state)
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            owner.close()
        self.assertEqual(owner.registry.pending(), 1)

    def test_cross_process_lock_timeout_is_unknown(self):
        first, second = RetrievalOwners(self.state), RetrievalOwners(self.state)
        with first._locked():
            with self.assertRaisesRegex(TimeoutError, "unknown"):
                with second._locked(timeout=0.02):
                    self.fail("another registry acquired the held lock")

    def test_owner_identity_is_bound_to_boot_and_namespace(self):
        owners = RetrievalOwners(self.state)
        admission = DrainAdmission()
        owner, other, host = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        proof = "a" * 64
        stat = Path("/proc/self/stat").read_text()
        start = stat[stat.rfind(")") + 2:].split()[19]
        owners.open(owner, host, os.getpid(), start, proof, admission.accepting)
        owners.open(other, host, os.getpid(), start, proof, admission.accepting)
        receipt = self.state / "owners" / (other + ".open")
        import json
        record = json.loads(receipt.read_text())
        record["boot"] = str(uuid.uuid4())
        receipt.write_text(json.dumps(record))
        self.assertTrue(owners.close(owner, proof, admission.drain)["unknown"])


if __name__ == "__main__":
    unittest.main()
