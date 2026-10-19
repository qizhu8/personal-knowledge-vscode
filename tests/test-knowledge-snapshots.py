from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "resources"))
from knowledge_snapshots import KnowledgeSnapshots, next_run, _systemctl_user
from knowledge_mutations import trash_file


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-snapshot-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "knowledge"
        (self.root / "skills").mkdir(parents=True)
        (self.root / "notes").mkdir()
        (self.root / "skills/Keep.md").write_bytes(b"---\nname: Keep\n---\nSkill body\r\n")
        (self.root / "notes/Original.md").write_bytes(b"Original note\r\n")
        self.snapshots = KnowledgeSnapshots(self.root, shutil.which("node"), REPO)

    def test_immutable_tags_with_real_bytes_and_unchanged_source(self):
        before = (self.root / "skills/Keep.md").read_bytes()
        first = self.snapshots.create()
        (self.root / "skills/Keep.md").write_bytes(b"new body")
        second = self.snapshots.create()
        self.assertNotEqual(first["tag"], second["tag"])
        self.assertEqual(self.snapshots.git("show", first["tag"] + ":skills/Keep.md"), before)
        self.assertEqual(self.snapshots.git("show", second["tag"] + ":skills/Keep.md"), b"new body")
        self.assertEqual(len(self.snapshots.status()["tags"]), 2)
        self.assertFalse((self.root / ".git").exists(), "snapshot Git storage is isolated from any user index")

    def test_preview_and_restore_with_trash_and_safety_snapshot(self):
        tag = self.snapshots.create()["tag"]
        (self.root / "notes/Original.md").write_bytes(b"changed after snapshot")
        (self.root / "notes/Extra.md").write_bytes(b"extra after snapshot")
        preview = self.snapshots.restore_preview(tag)
        self.assertEqual(len(preview["changes"]), 2)
        result = self.snapshots.restore_apply(preview["preview_id"], preview["approved_sha256"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual((self.root / "notes/Original.md").read_bytes(), b"Original note\r\n")
        self.assertFalse((self.root / "notes/Extra.md").exists())
        payloads = list((self.root / "notes/.trash").glob("*/payload"))
        self.assertEqual({file.read_bytes() for file in payloads}, {b"changed after snapshot", b"extra after snapshot"})
        self.assertTrue(result["before_snapshot"])
        self.assertTrue((self.root / ".pkm/state/knowledge-deletions.json").exists())

    def test_stale_preview_never_mutates(self):
        tag = self.snapshots.create()["tag"]
        (self.root / "notes/Original.md").write_bytes(b"change")
        preview = self.snapshots.restore_preview(tag)
        (self.root / "notes/Original.md").write_bytes(b"newer change")
        with self.assertRaises(ValueError):
            self.snapshots.restore_apply(preview["preview_id"], preview["approved_sha256"])
        self.assertEqual((self.root / "notes/Original.md").read_bytes(), b"newer change")
        self.assertFalse((self.root / "notes/.trash").exists())

    def test_symlink_or_unstable_inventory_never_publishes_tag(self):
        (self.root / "skills/Link.md").symlink_to(self.root / "notes/Original.md")
        with self.assertRaises(ValueError):
            self.snapshots.create()
        self.assertEqual(self.snapshots.status()["tags"], [])
        (self.root / "skills/Link.md").unlink()
        actual = self.snapshots.inventory()
        with patch.object(self.snapshots, "inventory", side_effect=[actual, {}]):
            with self.assertRaises(RuntimeError):
                self.snapshots.create()
        self.assertEqual(self.snapshots.status()["tags"], [])

    def test_dst_is_displayed_and_converted_to_utc(self):
        winter = next_run("17:00", "America/Los_Angeles", datetime(2026, 1, 17, 12, tzinfo=timezone.utc))
        summer = next_run("17:00", "America/Los_Angeles", datetime(2026, 7, 17, 12, tzinfo=timezone.utc))
        self.assertEqual(winter["abbreviation"], "PST")
        self.assertEqual(winter["next_run_utc"], "2026-01-18T01:00:00+00:00")
        self.assertEqual(summer["abbreviation"], "PDT")
        self.assertEqual(summer["next_run_utc"], "2026-07-18T00:00:00+00:00")
        with self.assertRaises(ValueError):
            next_run("25:00", "UTC")

    def test_shared_mcp_delete_keeps_skill_bytes_and_journal(self):
        before = (self.root / "skills/Keep.md").read_bytes()
        result = trash_file(self.root, "skills", "Keep.md", shutil.which("node"), REPO)
        self.assertTrue(result["ok"])
        payload = self.root / "skills/.trash" / result["trash"]["id"] / "payload"
        self.assertEqual(payload.read_bytes(), before)
        journal = json.loads((self.root / ".pkm/state/knowledge-deletions.json").read_text())
        self.assertTrue(any(row["path"] == "skills/Keep.md" for row in journal["records"]))

    @unittest.skipUnless(sys.platform == "linux", "Linux user systemd environment")
    def test_stdio_environment_without_runtime_variable_resolves_user_bus(self):
        metadata = SimpleNamespace(st_uid=os.getuid(), st_mode=stat.S_IFDIR | 0o700)
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "stat", return_value=metadata), \
                patch("knowledge_snapshots.subprocess.run",
                      return_value=subprocess.CompletedProcess([], 0, "reloaded", "")) as run:
            self.assertEqual(_systemctl_user("daemon-reload"), "reloaded")
            self.assertEqual(run.call_args.kwargs["env"]["XDG_RUNTIME_DIR"], "/run/user/" + str(os.getuid()))

    @unittest.skipUnless(sys.platform == "linux", "Linux user systemd environment")
    def test_untrusted_runtime_directory_is_rejected(self):
        metadata = SimpleNamespace(st_uid=os.getuid() + 1, st_mode=stat.S_IFDIR | 0o700)
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "stat", return_value=metadata), \
                patch("knowledge_snapshots.subprocess.run") as run:
            with self.assertRaisesRegex(RuntimeError, "user-owned"):
                _systemctl_user("daemon-reload")
            run.assert_not_called()

    def test_scheduler_errors_include_systemctl_diagnostic(self):
        with patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/private/runtime"}), \
                patch("knowledge_snapshots.subprocess.run",
                      return_value=subprocess.CompletedProcess([], 1, "", "User bus is unavailable")):
            with self.assertRaisesRegex(RuntimeError, "User bus is unavailable"):
                _systemctl_user("daemon-reload")


if __name__ == "__main__":
    unittest.main()
