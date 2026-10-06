import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from adaptive_skill_retrieval import SkillDocument

spec = importlib.util.spec_from_file_location(
    "export_serving", Path(__file__).resolve().parents[1] / "scripts" / "export-si-serving-release.py",
)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class TestServingExporter(unittest.TestCase):
    def test_export_is_comparable_verified_current_and_exclusive(self):
        for failure in ("none", "ranking", "stale", "corpus", "unverified", "existing"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                database = root / "source.sqlite3"
                output = root / "release.json"
                document = SkillDocument.create(skill_id="alpha", title="alpha", description="", body="guide")
                config = {"retrieval_architecture_id": "dense-section"}
                metrics = {
                    "corpus_revision": "corpus", "dataset_revision": 20,
                    "evidence_type": "real_query_retrieval", "recall_at_k": .8, "mrr": .7,
                    "weights_after": {"route": 1.}, "validation_query_count": 1,
                    "validation_lineage": [{"query_id": "q1", "ranking": ["alpha"]}],
                }
                if failure == "unverified":
                    metrics["evidence_type"] = "simulated"
                with sqlite3.connect(database) as db:
                    db.executescript("""
                    CREATE TABLE evaluation_dataset_snapshots (snapshot_id TEXT, payload_json TEXT);
                    CREATE TABLE si_paths (path_id TEXT, config_json TEXT);
                    CREATE TABLE performance_tasks (task_id TEXT, path_id TEXT, state TEXT, dataset_snapshot_id TEXT, metrics_json TEXT);
                    """)
                    db.execute("INSERT INTO evaluation_dataset_snapshots VALUES (?,?)",
                               ("snap", json.dumps({"validation_anchor": [{"query_id": "q1", "query": "guide"}]})))
                    db.execute("INSERT INTO si_paths VALUES (?,?)", ("path", json.dumps(config)))
                    db.execute("INSERT INTO performance_tasks VALUES (?,?,?,?,?)",
                               ("winner", "path", "completed", "snap", json.dumps(metrics)))
                    if failure == "corpus":
                        db.execute("INSERT INTO performance_tasks VALUES (?,?,?,?,?)",
                                   ("other", "path", "completed", "snap", json.dumps({**metrics, "corpus_revision": "other"})))
                if failure == "existing":
                    output.write_text("existing")
                frozen = SimpleNamespace(
                    architecture_id="dense-section",
                    search=lambda query, limit: [] if failure == "ranking" else [SimpleNamespace(skill_version=document.version)],
                )
                argv = ["export", "--database", str(database), "--snapshot", "snap",
                        "--pkm-root", str(root), "--output", str(output)]
                with patch.object(sys, "argv", argv), patch.object(exporter, "load_pkm_skills", return_value=([document], {})), \
                        patch.object(exporter, "FrozenSkillPath", return_value=frozen), \
                        patch.object(exporter, "CollectorStore") as store, contextlib.redirect_stdout(io.StringIO()):
                    if failure == "stale":
                        store.return_value.evaluation_dataset.side_effect = ValueError("labels changed")
                    if failure == "none":
                        exporter.main()
                        store.return_value.evaluation_dataset.assert_called_once_with("winner", require_current=True)
                        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                        envelope = json.loads(output.read_text())
                        self.assertEqual(envelope["sha256"], exporter.canonical_digest(envelope["release"]))
                    else:
                        with self.assertRaises((ValueError, FileExistsError)):
                            exporter.main()
                        if failure == "existing":
                            self.assertEqual(output.read_text(), "existing")
                        else:
                            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
