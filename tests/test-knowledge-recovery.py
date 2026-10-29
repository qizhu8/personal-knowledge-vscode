import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "knowledge_recovery", Path(__file__).resolve().parents[1] / "resources" / "knowledge_recovery.py")
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class Registry:
    def __init__(self):
        self.tools = {}

    def tool(self, **kwargs):
        def register(function):
            self.tools[function.__name__] = function
            return function
        return register


class KnowledgeRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pkm-recovery-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "knowledge"
        self.root.mkdir()
        self.evidence = Path(self.temporary.name) / "evidence"
        (self.evidence / "blobs").mkdir(parents=True)
        self.content = b"---\nname: recovered\n---\nOriginal bytes\r\n"
        self.digest = hashlib.sha256(self.content).hexdigest()
        (self.evidence / "blobs" / self.digest).write_bytes(self.content)
        self.plan = {"schema": "pkm.knowledge-recovery/v1", "knowledgeRoot": str(self.root),
                     "files": [{"path": "skills/Recovered.md", "mode": "100644", "sha256": self.digest}]}
        self.write_plan()
        registry = Registry()
        recovery.register_knowledge_recovery_tools(registry, self.root)
        self.preview = registry.tools["knowledge_recovery_preview"]
        self.apply = registry.tools["knowledge_recovery_apply"]

    def write_plan(self):
        raw = json.dumps(self.plan).encode()
        (self.evidence / "plan.json").write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def test_restore_exact_bytes_and_idempotency(self):
        preview = self.preview(str(self.evidence))
        self.assertEqual(preview["counts"]["restore"], 1)
        result = self.apply(str(self.evidence), preview["plan_sha256"])
        self.assertEqual(result["restored"], 1)
        self.assertEqual((self.root / "skills/Recovered.md").read_bytes(), self.content)
        result = self.apply(str(self.evidence), preview["plan_sha256"])
        self.assertEqual(result["identical"], 1)
        self.assertEqual(result["restored"], 0)

    def test_existing_content_never_overwritten(self):
        destination = self.root / "skills/Recovered.md"
        destination.parent.mkdir()
        destination.write_bytes(b"new surviving content")
        result = self.apply(str(self.evidence), self.write_plan())
        self.assertEqual(result["preserved_existing"], 1)
        self.assertEqual(destination.read_bytes(), b"new surviving content")

    def test_reject_changed_plan_or_blob(self):
        with self.assertRaises(ValueError):
            self.apply(str(self.evidence), "0" * 64)
        (self.evidence / "blobs" / self.digest).write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            self.preview(str(self.evidence))
        self.assertFalse((self.root / "skills").exists())

    def test_reject_unsafe_paths_and_symlinks(self):
        for relative in ["skills/../escape", "papers/outside.md", "notes/.git/config",
                         "notes/.trash/entry", "skills/C:\\escape", "notes//empty"]:
            with self.subTest(relative=relative):
                self.plan["files"][0]["path"] = relative
                self.write_plan()
                with self.assertRaises(ValueError):
                    self.preview(str(self.evidence))
        (self.root / "skills").symlink_to(self.evidence, target_is_directory=True)
        self.plan["files"][0]["path"] = "skills/Recovered.md"
        self.write_plan()
        with self.assertRaises(ValueError):
            self.preview(str(self.evidence))

    def test_reject_duplicate_and_wrong_root(self):
        self.plan["files"].append(dict(self.plan["files"][0]))
        self.write_plan()
        with self.assertRaises(ValueError):
            self.preview(str(self.evidence))
        self.plan["files"].pop()
        self.plan["knowledgeRoot"] = str(self.evidence)
        self.write_plan()
        with self.assertRaises(ValueError):
            self.preview(str(self.evidence))


if __name__ == "__main__":
    unittest.main()
