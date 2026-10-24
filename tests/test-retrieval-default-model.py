"""Real default-weight import tests; use an explicitly supplied model directory."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = Path(os.environ.get("PKM_RETRIEVAL_SETUP_EXTENSION_ROOT", ROOT)) / "resources"
sys.path.insert(0, str(RESOURCES))
from retrieval_runtime import activate_engine
activate_engine()
from retrieval_solution import import_default_directory
from retrieval_solutions import SolutionManager


class DefaultModelTests(unittest.TestCase):
    def test_changed_selection_cannot_be_overwritten_by_an_old_setup(self):
        with tempfile.TemporaryDirectory(prefix="pkm-model-selection-") as directory:
            state = Path(directory)
            manager = SolutionManager(state, lambda target, value: target.write_text(json.dumps(value)))
            original = manager.status()["selection_revision"]
            manager.select(None)
            with self.assertRaisesRegex(ValueError, "selection changed during setup"):
                manager.select("a" * 64, expected_revision=original)
            self.assertIsNone(manager.requested)

    def test_missing_or_symbolic_link_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="pkm-default-model-") as directory:
            state = Path(directory)
            with self.assertRaisesRegex(ValueError, "real local model"):
                import_default_directory(state / "missing", state)
            if os.name != "nt":
                (state / "link").symlink_to(state, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "symbolic link"):
                    import_default_directory(state / "link", state)

    @unittest.skipUnless(os.environ.get("PKM_DEFAULT_MODEL_DIRECTORY"), "explicit local default weights required")
    def test_actual_pinned_weights_import_idempotently_without_enabling_or_claiming_quality(self):
        with tempfile.TemporaryDirectory(prefix="pkm-default-model-") as directory:
            state = Path(directory)
            source = Path(os.environ["PKM_DEFAULT_MODEL_DIRECTORY"])
            first = import_default_directory(source, state)
            second = import_default_directory(source, state)
            self.assertEqual(first["package_id"], second["package_id"])
            self.assertEqual(first["manifest"]["validation"], {})
            self.assertFalse((state / "solution-selection.json").exists())
            self.assertEqual(json.loads((state / "solutions" / first["package_id"] / "manifest.json").read_text()), first["manifest"])
            self.assertEqual((state / "solutions" / first["package_id"] / "model" / "model.safetensors").stat().st_size, 470641600)


if __name__ == "__main__":
    unittest.main()
