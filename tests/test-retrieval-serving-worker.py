import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


FAKE_PATH = '''
from adaptive_skill_retrieval.fusion import FusedHit
from adaptive_skill_retrieval.models import SkillVersion
class FrozenSkillPath:
    release_id = "fixture-release"
    architecture_id = "fixture-dense"
    validation = {"claim": "fixture only"}
    documents = [1, 2]
    def __init__(self, path): pass
    def compatible(self, values):
        return all(value["title"] != "changed" for value in values)
    def search(self, query, limit):
        if query == "explode":
            raise RuntimeError("fixture encoder unavailable")
        if query == "malformed":
            return [FusedHit(SkillVersion("missing", "frozen"), float("nan"), 0, ("fixture",))]
        return [FusedHit(SkillVersion(name, "frozen"), 1.0 / rank, rank, ("fixture",))
                for rank, name in enumerate(["private", "beta", "alpha"], 1)]
'''


class TestServingWorkerBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("PKM_RETRIEVAL_TEST_PYTHON")
        if configured:
            cls.python = configured
            cls.runtime = None
            return
        cls.runtime = tempfile.TemporaryDirectory(prefix="pkm-serving-runtime-")
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", cls.runtime.name], check=True)
        cls.python = str(Path(cls.runtime.name) / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python"))
        wheel = next((Path(__file__).resolve().parents[1] / "resources" / "vendor").glob(
            "adaptive_skill_retrieval-0.3.0.dev2026100504-*.whl"))
        subprocess.run([cls.python, "-m", "pip", "install", "--no-deps", str(wheel)],
                       check=True, stdout=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        if cls.runtime:
            cls.runtime.cleanup()

    def test_frozen_scope_filters_errors_and_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copy2(Path(__file__).resolve().parents[1] / "resources" / "retrieval_worker.py", root)
            shutil.copy2(Path(__file__).resolve().parents[1] / "resources" / "retrieval_solutions.py", root)
            shutil.copy2(Path(__file__).resolve().parents[1] / "resources" / "retrieval_solution_resources.py", root)
            (root / "retrieval_serving.py").write_text(FAKE_PATH)
            state = root / "state"
            state.mkdir()
            (state / "serving-release.json").write_text("{}")
            values = [{
                "skill_id": "skill:" + name, "source_id": name, "title": name,
                "description": "guidance", "body": "help with guidance",
                "content_type": "skill", "visibility": "private" if name == "private" else "available",
            } for name in ("alpha", "beta", "private")]
            (state / "snapshot.json").write_text(json.dumps({
                "corpus_revision": "fixture-1", "generation": 1, "documents": values,
            }))
            with (root / "worker.log").open("w") as log:
                process = subprocess.Popen([self.python, str(root / "retrieval_worker.py"), str(state)],
                                           stdout=log, stderr=log)
                try:
                    endpoint_path = state / "worker.json"
                    self.wait(lambda: endpoint_path.exists() or process.poll() is not None)
                    self.assertTrue(endpoint_path.exists(), (root / "worker.log").read_text())
                    endpoint = json.loads(endpoint_path.read_text())

                    def request(route, payload=None):
                        req = urllib.request.Request(
                            f"http://127.0.0.1:{endpoint['port']}{route}",
                            data=None if payload is None else json.dumps(payload).encode(),
                            headers={"X-PKM-Retrieval-Token": endpoint["token"]},
                        )
                        try:
                            with urllib.request.urlopen(req, timeout=5) as response:
                                return json.load(response)
                        except urllib.error.HTTPError as error:
                            return json.load(error)

                    self.wait(lambda: request("/status")["skill_serving"]["ready"])
                    query = {"query": "find guidance", "content_type_filter": ["skill"], "limit": 5}
                    result = request("/search", query)
                    self.assertTrue(result["skill_serving"]["used"])
                    self.assertEqual([hit["skill_id"] for hit in result["hits"]], ["skill:beta", "skill:alpha"])
                    scoped = request("/search", {**query, "scope": {"source_ids": ["alpha"]}})
                    self.assertEqual([hit["skill_id"] for hit in scoped["hits"]], ["skill:alpha"])
                    for extra in ({"content_type_filter": ["note"]}, {"query": "$beta$"}):
                        self.assertFalse(request("/search", {**query, **extra})["skill_serving"]["used"])
                    self.assertEqual(request("/search", {**query, "content_type_filter": []})["code"], "invalid-filter")
                    failure = request("/search", {**query, "query": "explode"})
                    self.assertFalse(failure["skill_serving"]["used"])
                    self.assertIn("encoder unavailable", failure["skill_serving"]["fallback_reason"])
                    malformed = request("/search", {**query, "query": "malformed"})
                    self.assertTrue(malformed["ok"])
                    self.assertFalse(malformed["skill_serving"]["used"])
                    self.assertIn("invalid hit", malformed["skill_serving"]["fallback_reason"])
                    recovered = request("/search", query)
                    self.assertTrue(recovered["ok"])
                    self.assertTrue(recovered["skill_serving"]["used"])
                    self.assertEqual(request("/search", {**query, "deadline_at_ms": 1})["code"], "deadline-exceeded")
                    self.assertEqual(request("/search", {**query, "generation": {"mode": "exact", "generation": 2}})["code"], "generation-not-ready")
                    values[0]["title"] = "changed"
                    request("/index", {"corpus_revision": "fixture-2", "generation": 2, "documents": values})
                    self.wait(lambda: request("/status")["corpus_revision"] == "fixture-2")
                    stale = request("/search", query)
                    self.assertFalse(stale["skill_serving"]["used"])
                    self.assertIn("corpus changed", stale["skill_serving"]["fallback_reason"])
                    request("/shutdown", {})
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)

    def wait(self, check):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.03)
        self.fail("Worker did not reach expected state")


if __name__ == "__main__":
    unittest.main()
