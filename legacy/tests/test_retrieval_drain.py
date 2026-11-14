import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from retrieval_drain import DrainAdmission


class RetrievalDrainTests(unittest.TestCase):
    def test_waits_for_admitted_request_and_its_late_background_work(self):
        admission = DrainAdmission()
        self.assertTrue(admission.enter())
        self.assertTrue(admission.drain())
        self.assertFalse(admission.enter())
        admission.retain()
        admission.leave()
        stopped = threading.Event()
        waiter = threading.Thread(target=lambda: (admission.wait(), stopped.set()))
        waiter.start()
        self.assertFalse(stopped.wait(0.1))
        admission.leave()
        self.assertTrue(stopped.wait(2))
        waiter.join()
        self.assertFalse(admission.drain())


if __name__ == "__main__":
    unittest.main()
