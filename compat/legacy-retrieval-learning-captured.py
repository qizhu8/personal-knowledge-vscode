# Generated exact original learner; native adapter supplies only an in-memory connection.
import hashlib,json,math,os,re,secrets,sqlite3,threading
from pathlib import Path
class RetrievalLearning:
    """Bounded local ranker/calibrator; frozen embeddings, replayable judgments."""

    MIN_JUDGED_CALLS = 8
    BASE_SLOPE = 4.0
    BASE_BIAS = -2.0
    MIN_GAP = 0.15
    RETAIN_PROBABILITY = 0.65
    DISCARD_PROBABILITY = 0.35
    THRESHOLD_EWMA = 0.1
    RETENTION = 512
    FEATURES = 512
    MAX_CANDIDATES = 256
    MAX_QUERY = 8192
    MAX_LABEL_BYTES = 262144

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
                CREATE TABLE IF NOT EXISTS query_judgments (
                    context TEXT NOT NULL, query_key TEXT NOT NULL, receipt TEXT NOT NULL,
                    call_id INTEGER NOT NULL, candidates TEXT NOT NULL, query_features TEXT NOT NULL,
                    labels TEXT NOT NULL, label_digest TEXT NOT NULL, version INTEGER NOT NULL,
                    PRIMARY KEY(context,query_key));
            """)
            connection.execute("INSERT OR IGNORE INTO settings VALUES ('salt',?)", (secrets.token_hex(32),))
            connection.execute("INSERT OR IGNORE INTO settings VALUES ('enabled','false')")
            opt_in = connection.execute("SELECT value FROM settings WHERE key='online_learning_opt_in_version'").fetchone()
            if not opt_in:
                connection.execute("UPDATE settings SET value='false' WHERE key='enabled'")
                connection.execute("INSERT INTO settings VALUES ('online_learning_opt_in_version','1')")
            elif opt_in[0] != "1":
                raise ValueError("Unsupported online retrieval learning opt-in settings version")
            self.salt = connection.execute("SELECT value FROM settings WHERE key='salt'").fetchone()[0]
            additions = {
                "models": {"weights": "TEXT NOT NULL DEFAULT '[]'", "revision": "INTEGER NOT NULL DEFAULT 0",
                           "model_labels": "INTEGER NOT NULL DEFAULT 0", "user_labels": "INTEGER NOT NULL DEFAULT 0",
                           "prequential": "TEXT NOT NULL DEFAULT '{}'"},
                "calls": {"labels": "TEXT", "provenance": "TEXT", "version": "INTEGER NOT NULL DEFAULT 0",
                          "query_features": "TEXT NOT NULL DEFAULT '[]'", "brier": "REAL", "log_loss": "REAL",
                          "query_key": "TEXT", "judged": "TEXT"},
            }
            for table, columns in additions.items():
                existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                for column, definition in columns.items():
                    if column not in existing:
                        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            if not connection.execute("SELECT 1 FROM settings WHERE key='learner_version'").fetchone():
                # Legacy digests do not contain replayable labels. Never retain their gradients.
                connection.execute("UPDATE models SET slope=?,bias=?,threshold=?,samples=0,safe_streak=0",
                                   (self.BASE_SLOPE, self.BASE_BIAS, self.MIN_GAP))
                connection.execute("UPDATE calls SET label_digest=NULL,recall=NULL")
                connection.execute("INSERT INTO settings VALUES ('learner_version','2')")
        os.chmod(self.database, 0o600)

    def connect(self):
        return sqlite3.connect(self.database, timeout=10)

    def identity(self, value):
        return hashlib.sha256((self.salt + str(value)).encode("utf-8")).hexdigest()

    def calibration_status(self, enabled, samples, streak):
        ready = bool(enabled and samples >= self.MIN_JUDGED_CALLS and streak >= self.MIN_JUDGED_CALLS)
        return {
            "state": "disabled" if not enabled else "ready" if ready else "collecting-feedback",
            "calibration_ready": ready,
            "judged_calls": samples,
            "safe_streak": streak,
            "minimum_judged_calls": self.MIN_JUDGED_CALLS,
        }

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

    def features(self, source, query_features):
        keys = ["source:" + source, "source-secondary:" + source]
        if query_features:
            keys.append("query-source:" + source + ":".join(query_features))
            keys.extend("token-source:" + source + token for token in query_features[:8])
        values = {}
        for key in keys:
            digest = self.identity(key)
            index = int(digest[:8], 16) % self.FEATURES
            sign = 1 if int(digest[8], 16) % 2 else -1
            values[index] = values.get(index, 0) + sign / math.sqrt(len(keys))
        return values

    def ranked(self, candidates, query_features, weights):
        values = []
        for index, item in enumerate(candidates):
            features = self.features(item["id"], query_features)
            delta = sum(weights[key] * value for key, value in features.items())
            score = max(0.0, min(1.0, item.get("base_x", item["x"]) + .75 * math.tanh(delta)))
            values.append({**item, "x": score, "position": index, "features": features})
        return sorted(values, key=lambda item: (-item["x"], item.get("base_position", item["position"])))

    def observe(self, result, milliseconds, query=None, output_limit=None):
        if not result.get("model_invoked"):
            return
        hits = result.get("hits") or []
        delivered_limit = min(len(hits), output_limit) if output_limit is not None else len(hits)
        valid = isinstance(hits, list) and len(hits) <= self.MAX_CANDIDATES
        scores = []
        if valid:
            try:
                scores = [float(hit["score"]) for hit in hits]
                valid = (all(math.isfinite(score) for score in scores) and
                         all(scores[i] >= scores[i + 1] for i in range(len(scores) - 1)) and
                         all(isinstance(hit.get("source_id"), str) and
                             0 < len(hit["source_id"]) <= 4096 for hit in hits) and
                         all(isinstance(hit.get("metadata") or {}, dict) and
                             all((hit.get("metadata") or {}).get(key) is None or
                                 isinstance((hit.get("metadata") or {}).get(key), str)
                                 for key in ("priority", "source_priority")) for hit in hits) and
                         len({hit["source_id"] for hit in hits}) == len(hits))
            except (TypeError, ValueError, KeyError):
                valid = False
        query_valid = query is None or isinstance(query, str) and len(query) <= self.MAX_QUERY
        valid = valid and query_valid
        query_features = sorted({self.identity(token) for token in
                                 re.findall(r"\w+", query.casefold())[:16]}) if query and query_valid else []
        query_key = self.identity("query:" + " ".join(query.casefold().split())) if isinstance(query, str) and query_valid else None
        scale = max((abs(score) for score in scores), default=0) or 1
        candidates = [{"id": self.identity(hit["source_id"]), "x": max(0, min(1, score / scale)),
                       "base_x": max(0, min(1, score / scale)), "base_position": index}
                      for index, (hit, score) in enumerate(zip(hits, scores))] if valid else []
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
            connection.execute("INSERT OR IGNORE INTO models(context,package,corpus,route,slope,bias,threshold,samples,safe_streak) VALUES (?,?,?,?,?,?,?,?,?)",
                               (context, package, corpus, route, self.BASE_SLOPE, self.BASE_BIAS, self.MIN_GAP, 0, 0))
            slope, bias, threshold, samples, streak, serialized_weights, revision = connection.execute(
                "SELECT slope,bias,threshold,samples,safe_streak,weights,revision FROM models WHERE context=?", (context,)).fetchone()
            enabled = connection.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()[0] == "true"
            weights = json.loads(serialized_weights) or [0.0] * self.FEATURES
            reranked = bool(enabled and eligible and samples and any(weights))
            delivered = hits
            if reranked:
                ranked = self.ranked(candidates, query_features, weights)
                delivered = [{**hits[item["position"]], "base_score": hits[item["position"]]["score"],
                              "base_score_semantics": hits[item["position"]].get("score_semantics", "engine-defined"),
                              "learned_score": item["x"], "score": item["x"],
                              "score_semantics": "engine-defined", "rank": rank}
                             for rank, item in enumerate(ranked, 1)]
                scoring_candidates = ranked
            else:
                scoring_candidates = candidates
            k, gap = self.gap(scoring_candidates)
            cut = delivered_limit
            reason = "insufficient-feedback"
            if not enabled:
                reason = "disabled"
            elif not eligible:
                reason = "protected-or-unavailable"
            elif samples >= self.MIN_JUDGED_CALLS and streak >= self.MIN_JUDGED_CALLS:
                reason = "no-reliable-gap"
                if (k and k < delivered_limit and gap >= threshold and
                        self.probability(scoring_candidates[k - 1]["x"], slope, bias) >= self.RETAIN_PROBABILITY and
                        self.probability(scoring_candidates[k]["x"], slope, bias) <= self.DISCARD_PROBABILITY):
                    cut, reason = k, "calibrated-score-gap"
            # Store the baseline features in delivered order so recall uses what the caller saw.
            stored = [{key: value for key, value in item.items() if key not in {"features", "position"}}
                      for item in scoring_candidates]
            cursor = connection.execute("INSERT INTO calls(receipt,context,milliseconds,returned,candidates,cut,eligible,success,query_features,query_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
                                        (receipt, context, milliseconds, cut, json.dumps(stored), cut, int(eligible),
                                         int(bool(result.get("ok")) and result.get("semantic_status") == "ready"),
                                         json.dumps(query_features), query_key))
            invocation = cursor.lastrowid
            expired_contexts = {row[0] for row in connection.execute(
                "SELECT DISTINCT context FROM calls WHERE labels IS NOT NULL AND id NOT IN "
                "(SELECT id FROM calls ORDER BY id DESC LIMIT ?)", (self.RETENTION,))}
            connection.execute("DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT ?)", (self.RETENTION,))
            connection.execute("DELETE FROM models WHERE context NOT IN (SELECT context FROM calls UNION SELECT context FROM query_judgments)")
            for expired in expired_contexts:
                self.rebuild(connection, expired)
        result["retrieval_id"] = receipt
        result["adaptive"] = {"enabled": enabled, "applied": cut < delivered_limit, "reason": reason,
                              "original_count": delivered_limit, "returned_count": cut, "invocation": invocation}
        if reranked and "score_semantics" in result:
            result["base_score_semantics"] = result["score_semantics"]
            result["score_semantics"] = "engine-defined"
        result["online_learning"] = {"enabled": enabled, "applied": reranked, "revision": revision,
                                     "ranker_revision": revision, "calibrator_revision": revision,
                                     "embedding_updated": False}
        result["hits"] = delivered[:cut]

    def rebuild(self, connection, context):
        """Replay retained effective labels, never an old superseded gradient."""
        weights = [0.0] * self.FEATURES
        slope, bias, threshold = self.BASE_SLOPE, self.BASE_BIAS, self.MIN_GAP
        samples = streak = model_labels = user_labels = 0
        total_brier = total_loss = 0.0
        evaluated = 0
        connection.execute("UPDATE calls SET brier=NULL,log_loss=NULL WHERE context=?", (context,))
        effective = connection.execute(
            "SELECT c.id,c.candidates,c.query_features,c.labels,c.provenance,c.judged FROM calls c "
            "WHERE c.context=? AND c.labels IS NOT NULL AND NOT EXISTS "
            "(SELECT 1 FROM query_judgments q WHERE q.context=c.context AND q.query_key=c.query_key) "
            "UNION ALL SELECT call_id,candidates,query_features,labels,'user',NULL FROM query_judgments WHERE context=? "
            "ORDER BY 1", (context, context)).fetchall()
        for call, serialized, query, labels, provenance, judged in effective:
            candidates = json.loads(serialized)
            relevant = set(json.loads(labels))
            judged_ids = set(json.loads(judged)) if judged is not None else None
            ranked = self.ranked([item for item in candidates if judged_ids is None or item["id"] in judged_ids],
                                 json.loads(query), weights)
            gradients = []
            brier = loss = 0.0
            for item in ranked:
                target = int(item["id"] in relevant)
                probability = self.probability(item["x"], slope, bias)
                brier += (target - probability) ** 2
                loss -= target * math.log(max(1e-12, probability)) + (1 - target) * math.log(max(1e-12, 1 - probability))
                gradients.append((target - probability, item["x"]))
            count = len(ranked)
            if count:
                brier, loss = brier / count, loss / count
                total_brier += brier
                total_loss += loss
                evaluated += 1
                # Calibrator sees the current ranker's score, before either update.
                slope = max(.1, min(16, slope + .25 * sum(error * x for error, x in gradients) / count))
                bias = max(-12, min(12, bias + .25 * sum(error for error, _ in gradients) / count))
                updates = {}
                for item in ranked:
                    error = int(item["id"] in relevant) - self.probability(item["x"], self.BASE_SLOPE, self.BASE_BIAS)
                    for feature, value in item["features"].items():
                        updates[feature] = updates.get(feature, 0.0) + error * value
                for feature, update in updates.items():
                    weights[feature] = max(-4.0, min(4.0, weights[feature] + .5 * update / max(1, count / 8)))
            connection.execute("UPDATE calls SET brier=?,log_loss=? WHERE id=?",
                               (brier if count else None, loss if count else None, call))
            k, gap = self.gap(ranked)
            safe = bool(judged_ids is None and relevant and k and gap >= self.MIN_GAP
                        and relevant.issubset({item["id"] for item in ranked[:k]}))
            if judged_ids is None:
                target = max(self.MIN_GAP, gap * .75) if safe else min(.95, max(self.MIN_GAP, gap + .1))
                threshold = max(self.MIN_GAP, min(.95, (1 - self.THRESHOLD_EWMA) * threshold + self.THRESHOLD_EWMA * target))
            samples += 1
            streak = streak + 1 if safe else 0
            model_labels += provenance in ("self", "model")
            user_labels += provenance == "user"
        metrics = {"evaluated_calls": evaluated, "brier": total_brier / evaluated if evaluated else None,
                   "log_loss": total_loss / evaluated if evaluated else None,
                   "evaluation": "pre-update-retained-replay"}
        connection.execute("UPDATE models SET slope=?,bias=?,threshold=?,samples=?,safe_streak=?,weights=?,"
                           "revision=revision+1,model_labels=?,user_labels=?,prequential=? WHERE context=?",
                           (slope, bias, threshold, samples, streak, json.dumps(weights), model_labels,
                            user_labels, json.dumps(metrics), context))

    def feedback(self, receipt, relevant_source_ids, complete, provenance="user", judged_source_ids=None):
        if (not isinstance(receipt, str) or len(receipt) != 48 or
                any(char not in "0123456789abcdef" for char in receipt)):
            raise ValueError("Invalid retrieval_id")
        partial = judged_source_ids is not None
        if ((partial and complete is not False or not partial and complete is not True) or not isinstance(relevant_source_ids, list) or
                not 0 <= len(relevant_source_ids) <= 10000 or
                any(not isinstance(value, str) or not value or len(value) > 4096 for value in relevant_source_ids)):
            raise ValueError("Provide relevant_source_ids and complete=true, or complete=false with explicit judged_source_ids")
        if sum(len(value.encode("utf-8")) for value in relevant_source_ids) > self.MAX_LABEL_BYTES:
            raise ValueError("Relevance judgments exceed the bounded label size")
        if provenance not in ("self", "model", "user"):
            raise ValueError("provenance must be model or user (self is a model alias)")
        provenance = "model" if provenance == "self" else provenance
        if partial and (provenance != "model" or not isinstance(judged_source_ids, list)
                        or not 1 <= len(judged_source_ids) <= self.MAX_CANDIDATES
                        or any(not isinstance(value, str) or not value or len(value) > 4096 for value in judged_source_ids)
                        or len(set(judged_source_ids)) != len(judged_source_ids)
                        or not set(relevant_source_ids).issubset(judged_source_ids)
                        or sum(len(value.encode("utf-8")) for value in judged_source_ids) > self.MAX_LABEL_BYTES):
            raise ValueError("Partial model feedback requires bounded unique judged_source_ids containing all relevant sources")
        judged = {self.identity(value) for value in judged_source_ids} if partial else None
        relevant = {self.identity(value) for value in relevant_source_ids}
        digest = self.identity(json.dumps([sorted(relevant), sorted(judged)])) if partial else self.identity(json.dumps(sorted(relevant)))
        with self.lock, self.connect() as connection:
            row = connection.execute("SELECT context,candidates,cut,eligible,recall,label_digest,provenance,version,query_key,id,query_features FROM calls WHERE receipt=?", (receipt,)).fetchone()
            if not row:
                raise ValueError("Unknown or expired retrieval_id; only the latest 512 model calls are retained")
            context, serialized, cut, eligible, previous_recall, previous_digest, previous_provenance, version, query_key, call_id, query_features = row
            candidates = json.loads(serialized)
            if judged is not None and not judged.issubset({item["id"] for item in candidates[:cut]}):
                raise ValueError("Partial model judgments must reference delivered candidates only")
            authority = connection.execute(
                "SELECT receipt,label_digest FROM query_judgments WHERE context=? AND query_key=?",
                (context, query_key)).fetchone() if query_key is not None else None
            query_labeled = query_key is not None and connection.execute(
                "SELECT 1 FROM calls WHERE context=? AND query_key=? AND labels IS NOT NULL LIMIT 1",
                (context, query_key)).fetchone() is not None
            enabled = connection.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()[0] == "true"
            ignored = bool(provenance == "model" and (previous_provenance == "user" or authority))
            duplicate = bool(previous_digest == digest and previous_provenance == provenance)
            if provenance == "user" and authority and authority != (receipt, digest):
                duplicate = False
            if duplicate or ignored:
                samples, streak, revision, model_labels, user_labels = connection.execute(
                    "SELECT samples,safe_streak,revision,model_labels,user_labels FROM models WHERE context=?", (context,)).fetchone()
                return {"ok": True, "recall": previous_recall, "duplicate": duplicate, "ignored": ignored,
                        "reason": "user-precedence" if ignored else "duplicate", "trained": False,
                        "superseded": False, "version": version, "provenance": "user" if ignored else previous_provenance,
                        "revision": revision, "ranker_revision": revision, "calibrator_revision": revision,
                        "model_labels": model_labels, "user_labels": user_labels,
                        **self.calibration_status(enabled, samples, streak)}
            if not eligible:
                raise ValueError("This call is not eligible for relevance calibration")
            if not enabled:
                raise ValueError("Online retrieval learning is disabled")
            retained = {item["id"] for item in candidates[:cut]}
            recall = len(retained & relevant) / len(relevant) if relevant and not partial else None
            connection.execute("UPDATE calls SET recall=?,label_digest=?,labels=?,provenance=?,version=?,judged=? WHERE receipt=?",
                               (recall, digest, json.dumps(sorted(relevant)), provenance, version + 1,
                                json.dumps(sorted(judged)) if partial else None, receipt))
            if provenance == "user" and query_key is not None:
                connection.execute(
                    "INSERT INTO query_judgments(context,query_key,receipt,call_id,candidates,query_features,labels,label_digest,version) "
                    "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(context,query_key) DO UPDATE SET "
                    "receipt=excluded.receipt,call_id=excluded.call_id,candidates=excluded.candidates,"
                    "query_features=excluded.query_features,labels=excluded.labels,label_digest=excluded.label_digest,version=excluded.version",
                    (context, query_key, receipt, call_id, serialized, query_features, json.dumps(sorted(relevant)), digest, version + 1))
            self.rebuild(connection, context)
            samples, streak, revision, model_labels, user_labels = connection.execute(
                "SELECT samples,safe_streak,revision,model_labels,user_labels FROM models WHERE context=?", (context,)).fetchone()
        return {"ok": True, "recall": recall, "trained": True,
                "duplicate": False, "ignored": False, "superseded": bool(previous_digest or authority or
                                                                      provenance == "user" and query_labeled), "version": version + 1,
                "provenance": provenance, "revision": revision, "ranker_revision": revision, "calibrator_revision": revision,
                "model_labels": model_labels, "user_labels": user_labels,
                **self.calibration_status(enabled, samples, streak)}

    def summary(self):
        with self.lock, self.connect() as connection:
            enabled = connection.execute("SELECT value FROM settings WHERE key='enabled'").fetchone()[0] == "true"
            stored_calls = connection.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
            stored_user_judgments = connection.execute("SELECT COUNT(*) FROM query_judgments").fetchone()[0]
            calls = connection.execute(
                "SELECT c.id,c.context,c.milliseconds,c.returned,c.recall,c.success,c.provenance,c.version,c.brier,c.log_loss,"
                "CASE WHEN c.labels IS NULL THEN 0 WHEN EXISTS(SELECT 1 FROM query_judgments q "
                "WHERE q.context=c.context AND q.query_key=c.query_key AND q.receipt<>c.receipt) THEN 0 ELSE 1 END "
                ",c.candidates,c.cut,c.labels,c.judged FROM calls c ORDER BY c.id DESC LIMIT 256").fetchall()
            models = []
            for context, package, corpus, route, slope, bias, threshold, samples, streak, weights, revision, model_labels, user_labels, metrics in connection.execute(
                    "SELECT context,package,corpus,route,slope,bias,threshold,samples,safe_streak,weights,revision,model_labels,user_labels,prequential "
                    "FROM models WHERE context IN (SELECT context FROM calls ORDER BY id DESC LIMIT 256) ORDER BY rowid DESC LIMIT 16"):
                models.append({"context": context, "package_id": package, "corpus_revision": corpus, "route": route,
                               **self.calibration_status(enabled, samples, streak), "threshold": threshold,
                               "baseline": {"slope": self.BASE_SLOPE, "bias": self.BASE_BIAS},
                               "current": {"slope": slope, "bias": bias}, "revision": revision,
                               "ranker_revision": revision, "calibrator_revision": revision,
                               "model_labels": model_labels, "user_labels": user_labels,
                               "ranker": {"features": self.FEATURES, "weights": json.loads(weights),
                                          "weight_bound": 4.0, "active": bool(enabled and samples)},
                               "prequential": json.loads(metrics)})
        return {"enabled": enabled, "minimum_judged_calls": self.MIN_JUDGED_CALLS, "models": models,
                "stored_calls": stored_calls, "stored_user_judgments": stored_user_judgments,
                "policy": {"minimum_gap": self.MIN_GAP, "retain_probability": self.RETAIN_PROBABILITY,
                           "discard_probability": self.DISCARD_PROBABILITY, "threshold_ewma": self.THRESHOLD_EWMA,
                           "retention_calls": self.RETENTION},
                "calls": [{"invocation": i, "context": context, "runtime_ms": ms, "returned_count": count,
                           "recall": recall,
                           "precision": self.precision(candidates, cut, labels) if judged is None else None,
                           "judged_count": len(json.loads(judged)) if judged is not None else None,
                           "partial": judged is not None,
                           "success": bool(success), "provenance": provenance, "version": version,
                           "prequential_brier": brier, "prequential_log_loss": loss, "training_effective": bool(effective)}
                          for i, context, ms, count, recall, success, provenance, version, brier, loss, effective, candidates, cut, labels, judged in reversed(calls)],
                "retention": "latest 512 model calls locally; latest 256 shown; latest user authority per context+query persists beyond receipt expiry; no query text",
                "calibration": "sigmoid(slope * normalized_rank_score + bias); relative to each call's highest absolute score",
                "learning": "complete judgments or explicitly scoped partial model judgments train ranker/calibrator; unjudged candidates stay unknown; partial judgments cannot certify Recall or a safe truncation cliff; latest user overrides same context+normalized query across receipts; embeddings frozen",
                "embedding_updated": False}

    @staticmethod
    def precision(serialized_candidates, cut, serialized_labels):
        if serialized_labels is None:
            return None
        retained = {item["id"] for item in json.loads(serialized_candidates)[:cut]}
        return len(retained & set(json.loads(serialized_labels))) / len(retained) if retained else None
