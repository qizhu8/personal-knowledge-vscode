#!/usr/bin/env python3
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("diagnostic_log", ROOT / "resources" / "diagnostic_log.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DiagnosticLogTest(unittest.TestCase):
    def test_default_100000_row_window(self):
        with tempfile.TemporaryDirectory() as directory:
            log = MODULE.DiagnosticLog(directory)
            for index in range(100007):
                log.record("test", index=index)
            records = log.latest(100000)
            self.assertEqual(len(records), 100000)
            self.assertEqual(records[0]["index"], 7)
            self.assertEqual(records[-1]["index"], 100006)
            self.assertLessEqual(len(list(pathlib.Path(directory).glob("*.jsonl"))), 101)

    def test_retention_and_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            log = MODULE.DiagnosticLog(directory, max_rows=10, chunk_rows=3)
            for index in range(100):
                log.record("test", index=index, label="multiline\ntext")
            self.assertEqual([entry["index"] for entry in log.latest(10)], list(range(90, 100)))
            self.assertEqual([entry["index"] for entry in log.latest(2)], [98, 99])
            self.assertLessEqual(len(list(pathlib.Path(directory).glob("*.jsonl"))), 5)
            self.assertEqual(MODULE.latest(directory, log.writer_id, 10, 10), log.latest(10))
            with self.assertRaises(ValueError):
                log.latest(11)
            with self.assertRaises(ValueError):
                MODULE.latest(directory, "../../secret")

    def test_writer_isolation_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            first = MODULE.DiagnosticLog(directory, max_rows=3, chunk_rows=1)
            second = MODULE.DiagnosticLog(directory, max_rows=3, chunk_rows=1)
            second.record("second")
            for index in range(12):
                first.record("first", index=index)
            self.assertEqual(second.latest(1)[0]["event"], "second")
            with patch.object(MODULE.os, "open", side_effect=OSError("unavailable")):
                first.record("lost")
            first.record("recovered")
            self.assertEqual(first.latest(1)[0]["dropped"], 1)
            self.assertEqual(list(pathlib.Path(directory).glob("*.jsonl"))[0].stat().st_mode & 0o777, 0o600)

    def test_partial_record_and_field_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            log = MODULE.DiagnosticLog(directory)
            log.record("test", name="x" * 1000)
            filename = next(pathlib.Path(directory).glob("*.jsonl"))
            with filename.open("a", encoding="utf-8") as handle:
                handle.write('{"partial":')
            self.assertEqual(len(log.latest(1)[0]["name"]), 160)


if __name__ == "__main__":
    unittest.main()