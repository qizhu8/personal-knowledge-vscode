"""Manual package lifecycle and query-free, package-attributed runtime metrics."""

import json
import math
import hashlib
import os
import secrets
from pathlib import Path
import shutil
import sqlite3
import threading
import time
from retrieval_solution_resources import process_sample, resource_plan


class RetrievalLearning:
    """Query-free, context-isolated calibration from explicit complete judgments."""

    MIN_JUDGED_CALLS = 8
    BASE_SLOPE = 4.0
    BASE_BIAS = -2.0
    MIN_GAP = 0.15
    RETENTION = 512

    def __init__(self, state: Path):
        self.database = state / "retrieval-learning.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS models (
                    context TEXT PRIMARY KEY, package TEXT, corpus TEXT, route TEXT,
                    slope REAL, bias REAL, threshold REAL, samples INTEGER, safe_streak INTEGER);
                CREATE TABLE IF NOT EXISTS calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT UNIQUE, context TEXT,
                    milliseconds REAL, returned INTEGER, candidates TEXT, cut INTEGER,
                    eligible INTEGER, recall REAL, label_digest TEXT, success INTEGER);
            """)
            connection.execute("INSERT OR IGNORE INTO settings VALUES ('salt',?)", (secrets.token_hex(32),))
            connection.execute("INSERT OR IGNORE INTO settings VALUES ('enabled','true')")
            self.salt = connection.execute("SELECT value FROM settings WHERE key='salt'").fetchone()[0]
        os.chmod(self.database, 0o600)

    def connect(self):
        return sqlite3.connect(self.database, timeout=10)

    def identity(self, value):
        return hashlib.sha256((self.salt + str(value)).encode("utf-8")).hexdigest()

    @staticmethod
    def probability(x, slope, bias):
        return 1 / (1 + math.exp(-max(-40, min(40, slope * x + bias))))

    @staticmethod
    def gap(candidates):
        if len(candidates) < 2:
            return 0, 0.0
        gaps = [candidates[i]["x"] - candidates[i + 1]["x"] for i in range(len(candidates) - 1)]
        index = max(range(len(gaps)), key=gaps.__getitem__)
        return index + 1, gaps[index]

    def configure(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("Adaptive result count requires a boolean enabled value")
        with self.lock, self.connect() as connection:
            connection.execute("UPDATE settings SET value=? WHERE key='enabled'", (json.dumps(enabled),))

    def observe(self, result, milliseconds):
        if not result.get("model_invoked"):
            return
        hits = result.get("hits") or []
        scores = [float(hit["score"]) for hit in hits]
        valid = all(math.isfinite(score) for score in scores) and all(
            scores[i] >= scores[i + 1] for i in range(len(scores) - 1))
        scale = max((abs(score) for score in scores), default=0) or 1
        candidates = [{"id": self.identity(hit["source_id"]), "x": max(0, min(1, score / scale))}
                      for hit, score in zip(hits, scores)]
        package = result.get("model_attempt_package_id") or (result.get("skill_serving") or {}).get("release_id") or "unavailable"
        corpus = str(result.get("corpus_revision") or "")
        route = result.get("route")
        context = self.identity(json.dumps([package, corpus, route, "rrf" if route == "dual" else "engine-defined"]))
        eligible = (bool(result.get("ok")) and result.get("semantic_status") == "ready" and valid
                    and route in {"semantic", "dual"} and not result.get("exact_terms")
                    and not any((hit.get("metadata") or {}).get(key) in {"highest", "required"}
                                for hit in hits for key in ("priority", "source_priority")))
        receipt = secrets.token_hex(24)
        with self.lock, self.connect() as connection:
            connection.execute("INSERT OR IGNORE INTO models VALUES (?,?,?,?,?,?,?,?,?)",
                               (context, package, corpus, route, self.BASE_SLOPE, self.BASE_BIAS, self.MIN_GAP, 0, 0))
            slope, bias, threshold, samples, streak = connection.execute(
                "SELECT slope,bias,threshold,samples,safe_streak FROM models WHERE context=?", (context,)).fetchone()
            enabled = connection.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()[0] == "true"
            k, gap = self.gap(candidates)
            cut = len(hits)
            reason = "insufficient-feedback"
            if not enabled:
                reason = "disabled"
            elif not eligible:
                reason = "protected-or-unavailable"
            elif samples >= self.MIN_JUDGED_CALLS and streak >= self.MIN_JUDGED_CALLS:
                reason = "no-reliable-gap"
                if (k and gap >= threshold and
                        self.probability(candidates[k - 1]["x"], slope, bias) >= .65 and
                        self.probability(candidates[k]["x"], slope, bias) <= .35):
                    cut, reason = k, "calibrated-score-gap"
            cursor = connection.execute("INSERT INTO calls(receipt,context,milliseconds,returned,candidates,cut,eligible,success) VALUES (?,?,?,?,?,?,?,?)",
                                        (receipt, context, milliseconds, cut, json.dumps(candidates), cut, int(eligible),
                                         int(bool(result.get("ok")) and result.get("semantic_status") == "ready")))
            invocation = cursor.lastrowid
            connection.execute("DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT ?)", (self.RETENTION,))
            connection.execute("DELETE FROM models WHERE context NOT IN (SELECT DISTINCT context FROM calls)")
        result["retrieval_id"] = receipt
        result["adaptive"] = {"enabled": enabled, "applied": cut < len(hits), "reason": reason,
                              "original_count": len(hits), "returned_count": cut, "invocation": invocation}
        result["hits"] = hits[:cut]

    def feedback(self, receipt, relevant_source_ids, complete):
        if (not isinstance(receipt, str) or len(receipt) != 48 or
                any(char not in "0123456789abcdef" for char in receipt)):
            raise ValueError("Invalid retrieval_id")
        if (complete is not True or not isinstance(relevant_source_ids, list) or
                not 0 <= len(relevant_source_ids) <= 10000 or
                any(not isinstance(value, str) or not value or len(value) > 4096 for value in relevant_source_ids)):
            raise ValueError("Provide relevant_source_ids and complete=true for explicit complete relevance judgments")
        relevant = {self.identity(value) for value in relevant_source_ids}
        digest = self.identity(json.dumps(sorted(relevant)))
        with self.lock, self.connect() as connection:
            row = connection.execute("SELECT context,candidates,cut,eligible,recall,label_digest FROM calls WHERE receipt=?", (receipt,)).fetchone()
            if not row:
                raise ValueError("Unknown or expired retrieval_id; only the latest 512 model calls are retained")
            context, serialized, cut, eligible, previous_recall, previous_digest = row
            if previous_digest:
                if previous_digest != digest:
                    raise ValueError("Feedback already recorded with different judgments")
                return {"ok": True, "recall": previous_recall, "duplicate": True}
            if not eligible:
                raise ValueError("This call is not eligible for relevance calibration")
            candidates = json.loads(serialized)
            retained = {item["id"] for item in candidates[:cut]}
            recall = len(retained & relevant) / len(relevant) if relevant else None
            slope, bias, threshold, samples, streak = connection.execute(
                "SELECT slope,bias,threshold,samples,safe_streak FROM models WHERE context=?", (context,)).fetchone()
            gradients = [(int(item["id"] in relevant) - self.probability(item["x"], slope, bias), item["x"])
                         for item in candidates]
            if gradients:
                slope = max(.1, min(16, slope + .25 * sum(error * x for error, x in gradients) / len(gradients)))
                bias = max(-12, min(12, bias + .25 * sum(error for error, _ in gradients) / len(gradients)))
            k, gap = self.gap(candidates)
            safe = bool(relevant and k and gap >= self.MIN_GAP and relevant.issubset({item["id"] for item in candidates[:k]}))
            target = max(self.MIN_GAP, gap * .75) if safe else min(.95, max(self.MIN_GAP, gap + .1))
            threshold = max(self.MIN_GAP, min(.95, .9 * threshold + .1 * target))
            connection.execute("UPDATE models SET slope=?,bias=?,threshold=?,samples=?,safe_streak=? WHERE context=?",
                               (slope, bias, threshold, samples + 1, streak + 1 if safe else 0, context))
            connection.execute("UPDATE calls SET recall=?,label_digest=? WHERE receipt=?", (recall, digest, receipt))
        return {"ok": True, "recall": recall, "trained": True, "judged_calls": samples + 1}

    def summary(self):
        with self.lock, self.connect() as connection:
            enabled = connection.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()[0] == "true"
            calls = connection.execute(
                "SELECT id,context,milliseconds,returned,recall,success FROM calls ORDER BY id DESC LIMIT 256").fetchall()
            models = []
            for context, package, corpus, route, slope, bias, threshold, samples, streak in connection.execute(
                    "SELECT * FROM models WHERE context IN (SELECT context FROM calls ORDER BY id DESC LIMIT 256) ORDER BY rowid DESC LIMIT 16"):
                models.append({"context": context, "package_id": package, "corpus_revision": corpus, "route": route,
                               "judged_calls": samples, "safe_streak": streak, "threshold": threshold,
                               "baseline": {"slope": self.BASE_SLOPE, "bias": self.BASE_BIAS},
                               "current": {"slope": slope, "bias": bias}})
        return {"enabled": enabled, "minimum_judged_calls": self.MIN_JUDGED_CALLS, "models": models,
                "calls": [{"invocation": i, "context": context, "runtime_ms": ms, "returned_count": count, "recall": recall, "success": bool(success)}
                          for i, context, ms, count, recall, success in reversed(calls)],
                "retention": "latest 512 model calls locally; latest 256 shown; no query text",
                "calibration": "sigmoid(slope * normalized_rank_score + bias); relative to each call's highest absolute score",
                "learning": "explicit complete relevance judgments only; embedding weights remain frozen"}


class SolutionManager:
    def __init__(self, state: Path, atomic_json):
        self.directory = state / "solutions"
        self.selection = state / "solution-selection.json"
        self.atomic_json = atomic_json
        self.lock = threading.RLock()
        self.epoch = 0
        self.selection_revision = 0
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
                "selection_revision": self.selection_revision,
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

    def select(self, identity, *, rebuild=False, expected_revision=None):
        from adaptive_skill_retrieval.solution_package import load_installed
        with self.lock:
            if expected_revision is not None and expected_revision != self.selection_revision:
                raise ValueError("Model selection changed during setup. Verified files remain imported; enable explicitly.")
            if identity is not None:
                load_installed(self.directory, identity, verify=False)
            self.atomic_json(self.selection, {"schema": 1, "package_id": identity})
            self.managed = True
            self.selection_revision += 1
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
                              "bytes": getattr(candidate, "index_bytes", None), "persistent": True,
                              "embedding_cache_hits": getattr(candidate, "embedding_cache_hits", 0),
                              "embedding_cache_misses": getattr(candidate, "embedding_cache_misses", 0),
                              "embedding_cache_bytes": getattr(candidate, "embedding_cache_bytes", 0)}


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
