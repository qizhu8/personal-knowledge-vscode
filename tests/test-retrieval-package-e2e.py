"""Real offline package smoke test. Supply PKM_SOLUTION_SMOKE_PACKAGE explicitly."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

RESOURCES = Path(__file__).resolve().parents[1] / "resources"


@unittest.skipUnless(os.environ.get("PKM_SOLUTION_SMOKE_PACKAGE"), "requires an explicitly supplied offline package")
class TestOfflinePackageEndToEnd(unittest.TestCase):
    def test_import_enable_local_index_metrics_disable_delete(self):
        skill_count = int(os.environ.get("PKM_SOLUTION_SMOKE_SKILL_COUNT", "2"))
        self.assertTrue(2 <= skill_count <= 1000)
        with tempfile.TemporaryDirectory(prefix="pkm-package-e2e-") as temporary:
            state = Path(temporary)
            imported = subprocess.run(
                [sys.executable, str(RESOURCES / "retrieval_solution.py"), "--archive",
                 os.environ["PKM_SOLUTION_SMOKE_PACKAGE"], "--state", str(state)],
                check=True, capture_output=True, text=True,
            )
            identity = json.loads(imported.stdout)["package_id"]
            self.assertFalse((state / "solution-selection.json").exists())
            (state / "snapshot.json").write_text(json.dumps({
                "corpus_revision": "a" * 64, "generation": 1,
                "documents": [
                    {"skill_id": "skill:python", "title": "Python testing", "description": "Debug Python import errors",
                     "body": "# Imports\nUse pytest to reproduce Python import errors.", "content_type": "skill"},
                    {"skill_id": "skill:cooking", "title": "Cooking", "description": "Prepare dinner",
                     "body": "# Dinner\nCook rice and vegetables.", "content_type": "skill"},
                    {"skill_id": "note:private", "title": "Private", "description": "not a skill",
                     "body": "Private note", "content_type": "note", "visibility": "private"},
                ] + [{"skill_id": f"{kind}:python", "title": f"Python {kind}", "description": "Fix Python module imports",
                      "body": "# Python imports\nReproduce import errors and inspect the module search path.",
                      "content_type": kind, "read_only": kind == "recipe"} for kind in ("note", "script", "recipe", "research")]
                + [{"skill_id": f"skill:garden-{index}", "title": f"Garden care {index}",
                      "description": "Plants, soil and seasonal garden maintenance",
                      "body": f"# Watering\nWater garden plot {index} and inspect soil moisture.\n# Pruning\nRemove dead leaves and keep plants healthy.",
                      "content_type": "skill"} for index in range(skill_count - 2)],
            }))
            with (state / "worker.log").open("w") as log:
                process = subprocess.Popen([sys.executable, str(RESOURCES / "retrieval_worker.py"), str(state)],
                                           stdout=log, stderr=log)
                try:
                    self.wait(lambda: (state / "worker.json").exists())
                    endpoint = json.loads((state / "worker.json").read_text())
                    def request(route, payload=None):
                        req = urllib.request.Request(
                            f"http://127.0.0.1:{endpoint['port']}{route}",
                            data=json.dumps(payload).encode() if payload is not None else None,
                            headers={"X-PKM-Retrieval-Token": endpoint["token"]},
                        )
                        with urllib.request.urlopen(req, timeout=30) as response:
                            return json.load(response)
                    self.wait(lambda: request("/status")["ready"])
                    catalog = request("/solutions")
                    self.assertEqual(len(catalog["packages"]), 1)
                    self.assertIsNone(catalog["active_package_id"])
                    plan = catalog["packages"][0]["resources"]
                    self.assertEqual(plan["document_count"], skill_count + 5)
                    self.assertEqual(plan["content_type_counts"]["research"], 1)
                    self.assertGreater(plan["index_bytes_estimate"], 0)
                    with self.assertRaises(urllib.error.HTTPError) as invalid:
                        request("/solutions", {"action": "enable"})
                    self.assertEqual(invalid.exception.code, 400)
                    start = time.monotonic()
                    request("/solutions", {"action": "enable", "package_id": identity})
                    self.assertLess(time.monotonic() - start, 5, "Enable must enqueue rather than await model/index loading")
                    start = time.monotonic()
                    fallback = request("/search", {"query": "$python$", "content_type_filter": ["skill"], "limit": 2})
                    self.assertLess(time.monotonic() - start, 5, "Lexical requests must remain responsive during preparation")
                    self.assertFalse(fallback["skill_serving"]["used"])
                    phases = set()
                    def ready():
                        status = request("/solutions")
                        phases.add(status["progress"]["phase"])
                        if status["error"]:
                            self.fail(status["error"])
                        return status["active_package_id"] == identity
                    self.wait(ready, 120)
                    first_build = request("/solutions")
                    self.assertFalse(first_build["index"]["reused"])
                    self.assertGreater(first_build["index"]["bytes"], 0)
                    self.assertGreater(first_build["observed"]["cpu_core_equivalents"], 0)
                    self.assertGreater(first_build["observed"]["sampled_peak_rss_bytes"], 0)
                    self.assertTrue(phases.intersection({"verifying", "loading-model", "building-index", "encoding-documents-or-sections"}))
                    payload = {"route": "semantic", "query": "fix problems importing modules in python", "content_type_filter": ["skill"],
                               "limit": 2, "scope": {"capability_id": "pkm.search_skills"}}
                    result = request("/search", payload)
                    self.assertTrue(result["skill_serving"]["used"])
                    self.assertEqual(result["solution"]["package_id"], identity)
                    self.assertEqual(result["hits"][0]["skill_id"], "skill:python")
                    for kind in ("skill", "note", "script", "recipe", "research"):
                        typed = request("/search", {**payload, "content_type_filter": [kind]})
                        self.assertTrue(typed["skill_serving"]["used"])
                        self.assertTrue(typed["hits"])
                        self.assertTrue(all(hit["content_type"] == kind for hit in typed["hits"]))
                        self.assertNotIn("note:private", [hit["skill_id"] for hit in typed["hits"]])
                    unrestricted = request("/search", {**payload, "content_type_filter": [], "limit": 20})
                    self.assertEqual({hit["content_type"] for hit in unrestricted["hits"]}, {"skill", "note", "script", "recipe", "research"})
                    no_read_only = request("/search", {**payload, "content_type_filter": ["recipe"], "scope": {"include_read_only": False}})
                    self.assertEqual(no_read_only["hits"], [])
                    metrics = request("/solutions")["metrics"]
                    self.assertTrue(any(item["served_package_id"] == identity for item in metrics["buckets"]))
                    self.assertNotIn(payload["query"], json.dumps(metrics))
                    request("/shutdown", {})
                    process.wait(timeout=15)
                    process = subprocess.Popen([sys.executable, str(RESOURCES / "retrieval_worker.py"), str(state)],
                                               stdout=log, stderr=log)
                    self.wait(lambda: (state / "worker.json").exists())
                    endpoint = json.loads((state / "worker.json").read_text())
                    self.wait(ready, 120)
                    restored = request("/solutions")
                    self.assertTrue(restored["index"]["reused"], "Restart must load the persisted vectors/PCA, not re-encode")
                    self.assertTrue(request("/search", payload)["skill_serving"]["used"])
                    snapshot = json.loads((state / "snapshot.json").read_text())
                    snapshot.update(corpus_revision="b" * 64, generation=2)
                    snapshot["documents"][0]["body"] += "\nInspect import paths before changing dependencies."
                    request("/index", snapshot)
                    self.wait(lambda: request("/solutions")["corpus_revision"] == "b" * 64 and ready(), 120)
                    self.assertTrue(request("/search", payload)["skill_serving"]["used"])
                    self.assertFalse(request("/solutions")["index"]["reused"], "Skill changes must produce a new index")
                    indexes = list((state / "solution-indexes" / identity).glob("*.npz"))
                    self.assertEqual(len(indexes), 1, "Stale corpus caches must be pruned")
                    indexes[0].write_bytes(b"damaged cache")
                    request("/solutions", {"action": "disable"})
                    request("/solutions", {"action": "enable", "package_id": identity})
                    self.wait(lambda: bool(request("/solutions")["error"]), 120)
                    self.assertIn("Rebuild", request("/solutions")["error"])
                    request("/solutions", {"action": "rebuild", "package_id": identity})
                    self.wait(ready, 120)
                    self.assertTrue(request("/search", payload)["skill_serving"]["used"])
                    request("/solutions", {"action": "disable"})
                    self.assertFalse(request("/search", payload)["skill_serving"]["used"])
                    request("/solutions", {"action": "delete", "package_id": identity})
                    self.assertEqual(request("/solutions")["packages"], [])
                    self.assertTrue((state / "snapshot.json").exists())
                    self.assertFalse((state / "solution-indexes" / identity).exists())
                    self.assertTrue(request("/solutions")["metrics"]["buckets"])
                    print(json.dumps({"resource_estimate": plan, "first_build": first_build["observed"],
                                      "index_bytes": first_build["index"]["bytes"],
                                      "restart": restored["observed"], "phases_observed": sorted(phases)}))
                    request("/shutdown", {})
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=15)

    def wait(self, check, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if check():
                return
            time.sleep(.05)
        self.fail("Worker did not reach expected state")


if __name__ == "__main__":
    unittest.main()
