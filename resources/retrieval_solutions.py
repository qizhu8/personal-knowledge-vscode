"""Manual package lifecycle and query-free, package-attributed runtime metrics."""

import json
import math
from pathlib import Path
import shutil
import sqlite3
import threading
import time
from retrieval_solution_resources import process_sample, resource_plan


class SolutionManager:
    def __init__(self, state: Path, atomic_json):
        self.directory = state / "solutions"
        self.selection = state / "solution-selection.json"
        self.atomic_json = atomic_json
        self.lock = threading.RLock()
        self.epoch = 0
        self.path = None
        self.cached_path = None
        self.corpus = ""
        self.error = ""
        self.building = False
        self.build_ms = None
        self.progress = {"phase": "idle", "current": 0, "total": None}
        self.observed = {}
        self.index = {}
        self.requested = None
        self.managed = self.selection.exists()
        if self.managed:
            try:
                value = json.loads(self.selection.read_text())
                from adaptive_skill_retrieval.solution_package import ID
                if value.get("schema") != 1 or (value.get("package_id") is not None and not ID.fullmatch(str(value["package_id"]))):
                    raise ValueError("Invalid solution selection")
                self.requested = value["package_id"]
            except (OSError, ValueError, KeyError, ImportError) as error:
                self.error = f"Cannot restore solution selection: {error}"

    def capture(self):
        with self.lock:
            return self.epoch, self.requested, self.path, self.error

    def invalidate(self):
        with self.lock:
            if self.managed:
                self.epoch += 1
                self.path = None

    def status(self):
        with self.lock:
            return {
                "managed": self.managed, "requested_package_id": self.requested,
                "active_package_id": self.path.release_id if self.path else None,
                "state": "building" if self.building else "ready" if self.path else "blocked" if self.error else "queued" if self.requested else "disabled",
                "error": self.error, "corpus_revision": self.corpus,
                "build_ms": self.build_ms, "fallback": "exact-bm25",
                "progress": dict(self.progress), "observed": dict(self.observed),
                "index": dict(self.index), "process": process_sample(),
            }

    def catalog(self, documents=()):
        from adaptive_skill_retrieval.solution_package import load_installed, ID
        packages = []
        for root in sorted(self.directory.iterdir()) if self.directory.exists() else []:
            if not ID.fullmatch(root.name):
                continue
            try:
                manifest = load_installed(self.directory, root.name, verify=False)
                packages.append({
                    "package_id": root.name, "name": manifest["name"],
                    "architecture": manifest["architecture"], "license": manifest["license"],
                    "validation": manifest["validation"],
                    "bytes": sum(item["bytes"] for item in manifest["files"].values()),
                    "resources": resource_plan(root, manifest, documents),
                })
            except (OSError, ValueError, KeyError, TypeError) as error:
                packages.append({"package_id": root.name, "name": root.name, "error": str(error)})
        return {"packages": packages, **self.status()}

    def select(self, identity, *, rebuild=False):
        from adaptive_skill_retrieval.solution_package import load_installed
        with self.lock:
            if identity is not None:
                load_installed(self.directory, identity, verify=False)
            self.atomic_json(self.selection, {"schema": 1, "package_id": identity})
            self.managed = True
            self.requested = identity
            self.epoch += 1
            self.path = None
            self.cached_path = None
            self.corpus = ""
            self.error = ""
            self.building = False
            self.build_ms = None
            self.progress = {"phase": "queued" if identity else "disabled", "current": 0, "total": None}
            self.observed = {}
            self.index = {}
            if rebuild and identity:
                target = self.directory.parent / "solution-indexes" / identity
                if target.is_symlink():
                    raise ValueError("Index directory must not be a symlink")
                if target.exists():
                    shutil.rmtree(target)

    def delete(self, identity):
        from adaptive_skill_retrieval.solution_package import ID
        if not isinstance(identity, str) or not ID.fullmatch(identity):
            raise ValueError("Invalid solution package ID")
        with self.lock:
            root = self.directory / identity
            if not root.is_dir() or root.is_symlink():
                raise ValueError("Installed package directory does not exist or is a symlink")
            if self.requested == identity:
                self.select(None)
            # A build can still hold old model references, but its epoch cannot publish.
            shutil.rmtree(root)
            index = self.directory.parent / "solution-indexes" / identity
            if index.is_symlink():
                raise ValueError("Index directory must not be a symlink")
            if index.exists():
                shutil.rmtree(index)

    def build(self, documents, corpus):
        with self.lock:
            if not self.managed:
                return
            if self.requested is None and self.error:
                return
            versions = {document.version for document in documents}
            if self.cached_path is not None and self.cached_path.release_id == self.requested and versions == {document.version for document in self.cached_path.documents}:
                self.path = self.cached_path
                self.corpus = corpus
                self.building = False
                self.error = ""
                self.progress = {"phase": "ready", "current": len(versions), "total": len(versions)}
                return
            self.epoch += 1
            epoch, identity = self.epoch, self.requested
            self.path = None
            self.corpus = corpus
            self.error = ""
            self.building = bool(identity)
            self.observed = {}
            self.index = {}
            self.build_ms = None
            self.progress = {"phase": "queued" if identity else "disabled", "current": 0, "total": None}
        if identity is None:
            return
        start = time.perf_counter()
        baseline = process_sample()
        stop = threading.Event()
        def report(phase, current=0, total=None):
            with self.lock:
                if self.epoch != epoch:
                    raise RuntimeError("Solution build cancelled by lifecycle or corpus change")
                self.progress = {"phase": phase, "current": current, "total": total}
        def sample():
            value = process_sample()
            elapsed = max(value["wall_seconds"] - baseline["wall_seconds"], .001)
            with self.lock:
                if self.epoch == epoch:
                    self.observed = {
                        "elapsed_seconds": round(elapsed, 2), "rss_bytes": value["rss_bytes"],
                        "sampled_peak_rss_bytes": max(self.observed.get("sampled_peak_rss_bytes") or 0, value["rss_bytes"] or 0) or None,
                        "cpu_core_equivalents": round((value["cpu_seconds"] - baseline["cpu_seconds"]) / elapsed, 2),
                        "scope": value["scope"],
                    }
        def monitor():
            while not stop.wait(.5):
                sample()
        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        try:
            from retrieval_serving import ImportedSkillPath
            candidate = ImportedSkillPath(self.directory, identity, documents, progress=report, publication_lock=self.lock)
        except Exception as error:
            with self.lock:
                if self.epoch == epoch:
                    self.building = False
                    self.error = f"Local solution unavailable: {type(error).__name__}: {error}"
                    self.progress["phase"] = "failed"
            print(f"Solution {identity} failed: {error}", flush=True)
            return
        finally:
            stop.set()
            monitor_thread.join()
            sample()
        with self.lock:
            if self.epoch == epoch:
                self.path = candidate
                self.cached_path = candidate
                self.building = False
                self.build_ms = round((time.perf_counter() - start) * 1000, 2)
                self.progress = {"phase": "ready", "current": len(versions), "total": len(versions)}
                self.index = {"reused": getattr(candidate, "index_reused", False),
                              "bytes": getattr(candidate, "index_bytes", None), "persistent": True}


class SolutionMetrics:
    def __init__(self, state: Path):
        self.database = state / "solution-metrics.sqlite3"
        with self.connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS buckets (
                    bucket TEXT PRIMARY KEY, requested TEXT, served TEXT, corpus TEXT,
                    entry TEXT, reason TEXT, requests INTEGER, errors INTEGER, hits INTEGER);
                CREATE TABLE IF NOT EXISTS latencies (
                    id INTEGER PRIMARY KEY, bucket TEXT, milliseconds REAL);
                CREATE INDEX IF NOT EXISTS latency_bucket ON latencies(bucket, id);
            """)

    def connect(self):
        return sqlite3.connect(self.database, timeout=10)

    def record(self, *, requested, served, corpus, entry, reason, ok, hits, milliseconds):
        # Only bounded public enum identifiers, package/corpus hashes and counts persist.
        entry = entry if entry in {"pkm.skill_context", "pkm.search_skills", "pkm.search_knowledge"} else "other"
        key = json.dumps([requested, served, corpus, entry, reason])
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO buckets VALUES (?,?,?,?,?,?,1,?,?)
                   ON CONFLICT(bucket) DO UPDATE SET requests=requests+1,
                   errors=errors+excluded.errors,hits=hits+excluded.hits""",
                (key, requested, served, corpus, entry, reason, int(not ok), hits),
            )
            connection.execute("INSERT INTO latencies(bucket,milliseconds) VALUES (?,?)", (key, milliseconds))
            connection.execute(
                "DELETE FROM latencies WHERE bucket=? AND id NOT IN (SELECT id FROM latencies WHERE bucket=? ORDER BY id DESC LIMIT 256)",
                (key, key),
            )

    def summary(self):
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT bucket,requested,served,corpus,entry,reason,requests,errors,hits FROM buckets ORDER BY rowid DESC LIMIT 100"
            ).fetchall()
            result = []
            for key, requested, served, corpus, entry, reason, requests, errors, hits in rows:
                values = sorted(row[0] for row in connection.execute("SELECT milliseconds FROM latencies WHERE bucket=?", (key,)))
                result.append({
                    "requested_package_id": requested, "served_package_id": served,
                    "corpus_revision": corpus, "entry": entry, "reason": reason,
                    "requests": requests, "errors": errors, "returned_hits": hits,
                    "latency_sample_count": len(values),
                    "p50_ms": values[math.ceil(.5 * len(values)) - 1] if values else None,
                    "p95_ms": values[math.ceil(.95 * len(values)) - 1] if values else None,
                })
        return {"buckets": result, "latency_window": "latest 256 requests per bucket",
                "retention": "local history retained after package deletion; latest 100 buckets shown",
                "query_text_collected": False, "relevance_metrics": "unavailable without labels"}
