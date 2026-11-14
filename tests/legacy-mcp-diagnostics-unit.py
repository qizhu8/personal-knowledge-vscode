import importlib.util
import shutil
import sys
import unittest
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "resources"))
from diagnostic_log import DiagnosticLog

spec = importlib.util.spec_from_file_location("diagnostics", root / "next-server/compat/legacy-mcp-diagnostics.py")
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


class PaginationTest(unittest.TestCase):
    def setUp(self):
        self.directory = root / "next-server" / (".diagnostics-unit-" + uuid.uuid4().hex)
        self.directory.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.directory)
        self.log = DiagnosticLog(self.directory, max_rows=3, chunk_rows=1)

    def test_rollover_stable_cursor_and_expiry(self):
        for value in range(3):
            self.log.record("call", value=value)
        first = diagnostics.page(self.log, 1, None)
        self.assertEqual(first["records"][0]["value"], 2)
        self.log.record("call", value=3)
        second = diagnostics.page(self.log, 1, first["next_cursor"])
        self.assertEqual(second["records"][0]["value"], 1)
        self.assertEqual(diagnostics.page(self.log, 1, second["next_cursor"])["records"][0]["value"], 0)
        for value in range(4, 9):
            self.log.record("call", value=value)
        with self.assertRaisesRegex(ValueError, "expired"):
            diagnostics.page(self.log, 1, first["next_cursor"])
        latest = diagnostics.page(self.log, 3, None)
        self.assertEqual([item["value"] for item in latest["records"]], [8, 7, 6])
        self.assertIsNone(latest["next_cursor"])

    def test_reject_foreign_and_malformed_cursors(self):
        self.log.record("call")
        for cursor in ["different:1:0:0", f"{self.log.writer_id}:99:1:0", "1" * 1000]:
            with self.assertRaises(ValueError):
                diagnostics.page(self.log, 1, cursor)

    def test_history_append_stable_and_changed_prefix_rejected(self):
        log = DiagnosticLog(self.directory)
        for value in range(3):
            log.record("call", value=value)
        first = diagnostics.history_page(self.directory, log.writer_id, 1)
        log.record("call", value=3)
        second = diagnostics.history_page(self.directory, log.writer_id, 1, first["next_cursor"])
        self.assertEqual(second["records"][0]["value"], 1)
        path = next(self.directory.glob(f"{log.writer_id}.*.jsonl"))
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b'"value":0', b'"value":9'))
        with self.assertRaisesRegex(ValueError, "changed"):
            diagnostics.history_page(self.directory, log.writer_id, 1, second["next_cursor"])

    def test_history_denies_links_missing_chunks_and_bad_cursors(self):
        log = DiagnosticLog(self.directory)
        log.record("call")
        page = diagnostics.history_page(self.directory, log.writer_id, 1)
        self.assertIsNone(page["next_cursor"])
        path = next(self.directory.glob(f"{log.writer_id}.*.jsonl"))
        target = self.directory / "target"
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            diagnostics.history_page(self.directory, log.writer_id)
        path.unlink()
        target.rename(path)
        with self.assertRaises(ValueError):
            diagnostics.history_page(self.directory, log.writer_id, cursor="bad")
        path.rename(self.directory / f"{log.writer_id}.0000000001.jsonl")
        (self.directory / f"{log.writer_id}.0000000003.jsonl").write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "missing"):
            diagnostics.history_page(self.directory, log.writer_id)

    def test_writer_inventory_revision(self):
        self.log.record("call")
        first = diagnostics.writers(self.directory, limit=1)
        DiagnosticLog(self.directory).record("call")
        with self.assertRaisesRegex(ValueError, "changed"):
            diagnostics.writers(self.directory, offset=1, revision=first["revision"])

    def test_history_crosses_real_chunk_boundary(self):
        log = DiagnosticLog(self.directory)
        for value in range(1003):
            log.record("call", value=value)
        first = diagnostics.history_page(self.directory, log.writer_id, 5)
        self.assertEqual([row["value"] for row in first["records"]], [1002, 1001, 1000, 999, 998])
        next_page = diagnostics.history_page(self.directory, log.writer_id, 2, first["next_cursor"])
        self.assertEqual([row["value"] for row in next_page["records"]], [997, 996])
        oldest = self.directory / f"{log.writer_id}.0000000000.jsonl"
        oldest.unlink()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            diagnostics.history_page(self.directory, log.writer_id, 2, first["next_cursor"])


if __name__ == "__main__":
    unittest.main()
