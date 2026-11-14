import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from note_inventory import note_inventory_page


class NoteInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-note-inventory-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "notes"
        self.root.mkdir()

    def create(self, slug, identity=None):
        file = self.root / (slug + ".md")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({"identity": identity}), encoding="utf-8")
        return file

    def read(self, file, slug):
        return {"slug": slug, "title": file.stem, "type": "general", "documentKind": "markdown",
                "category": slug.rpartition("/")[0], "updated_at": str(file.stat().st_mtime_ns),
                "knowledge_id": json.loads(file.read_text(encoding="utf-8"))["identity"]}

    def page(self, **args):
        return note_inventory_page(self.root, self.read, **args)

    def test_all_125_notes_paginate_without_gaps_or_duplicates(self):
        for index in range(125):
            self.create(f"Project/Sub/Note {index:03}", f"knowledge_{index:024x}")
        self.create("Project-other/Excluded")
        first = self.page(directory="Project")
        seen, page = [], first
        while True:
            seen.extend(row["knowledge_id"] for row in page["notes"])
            self.assertTrue(page["complete"])
            self.assertTrue(page["identity_complete"])
            self.assertEqual(page["total"], 125)
            if page["next_offset"] is None:
                break
            page = self.page(directory="Project", offset=page["next_offset"],
                             inventory_revision=first["inventory_revision"])
        self.assertEqual(len(seen), 125)
        self.assertEqual(len(set(seen)), 125)
        unlimited = self.page(directory="Project", limit=0)
        self.assertEqual(unlimited["returned"], 125)
        self.assertIsNone(unlimited["next_offset"])
        self.assertFalse(unlimited["has_more"])
        self.assertEqual(unlimited["inventory_revision"], first["inventory_revision"])
        remaining = self.page(directory="Project", offset=50, limit=0,
                              inventory_revision=first["inventory_revision"])
        self.assertEqual(remaining["returned"], 75)
        self.assertIsNone(remaining["next_offset"])
        with self.assertRaisesRegex(ValueError, "Later pages"):
            self.page(directory="Project", offset=50)
        self.create("Project/Sub/Added")
        with self.assertRaisesRegex(ValueError, "changed between pages"):
            self.page(directory="Project", offset=50, inventory_revision=first["inventory_revision"])

    def test_directory_boundaries_hidden_assets_empty_and_nonrecursive(self):
        self.create("Project/Top")
        self.create("Project/Sub/Nested")
        for slug in ["Project/.trash/Hidden", "Project/Top.assets/Asset", "Project/_assets/Asset", "ProjectX/Other"]:
            self.create(slug)
        (self.root / "Empty").mkdir()
        self.assertEqual(self.page(directory="pkm://notes/Project/", recursive=False)["total"], 1)
        self.assertEqual(self.page(directory="notes/Project")["total"], 2)
        self.assertEqual(self.page(directory="Empty")["total"], 0)
        with self.assertRaisesRegex(ValueError, "not found"):
            self.page(directory="Missing")
        for invalid in ["/", "/Project", "../Project", "Project/../Sub", "Project//Sub", "pkm://notes/%2e%2e/"]:
            with self.assertRaises(ValueError):
                self.page(directory=invalid)

    def test_stable_identity_survives_move_and_missing_or_duplicate_ids_are_explicit(self):
        identity = "knowledge_" + "a" * 24
        old = self.create("Old/Note", identity)
        (self.root / "New").mkdir()
        old.rename(self.root / "New/Note.md")
        row = self.page(directory="New")["notes"][0]
        self.assertEqual(row["source_id"], "pkm://knowledge/" + identity)
        self.create("New/Legacy")
        self.create("New/Duplicate", identity)
        page = self.page(directory="New")
        self.assertFalse(page["identity_complete"])
        self.assertEqual(page["missing_identity_count"], 1)
        self.assertEqual(page["duplicate_identity_count"], 2)

    def test_read_errors_races_and_symlinks_never_report_complete(self):
        file = self.create("Project/Note")
        def changed(path, slug):
            row = self.read(path, slug)
            self.create("Project/Added")
            return row
        with self.assertRaisesRegex(ValueError, "changed during"):
            note_inventory_page(self.root, changed, directory="Project")
        def failed(path, slug):
            raise PermissionError("Cannot read Note")
        with self.assertRaises(PermissionError):
            note_inventory_page(self.root, failed)
        (self.root / "Linked.md").symlink_to(file)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.page()

    def test_invalid_paging_and_unchanged_read_only_files(self):
        file = self.create("Note")
        before = file.read_bytes(), file.stat().st_mtime_ns
        for args in [{"offset": -1}, {"limit": -1}, {"limit": True}, {"limit": 1.5}, {"recursive": "yes"}, {"inventory_revision": "bad"}]:
            with self.assertRaises(ValueError):
                self.page(**args)
        self.page()
        self.assertEqual((file.read_bytes(), file.stat().st_mtime_ns), before)

    def test_positive_limits_have_no_200_note_cap(self):
        for index in range(251):
            self.create(f"Note {index:03}", f"knowledge_{index:024x}")
        self.assertEqual(self.page()["returned"], 50)
        self.assertEqual(self.page(limit=250)["returned"], 250)
        self.assertEqual(self.page(limit=1000)["returned"], 251)
        self.assertEqual(self.page(limit=0)["returned"], 251)


if __name__ == "__main__":
    unittest.main()
