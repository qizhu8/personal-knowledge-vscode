#!/usr/bin/env python3
"""Export and replay-verify a provisional winner from one measured SI cohort."""

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
from retrieval_serving import FrozenSkillPath, canonical_digest
from adaptive_skill_retrieval.benchmark import load_pkm_skills
from adaptive_skill_retrieval.collector import CollectorStore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--pkm-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        snapshot = db.execute(
            "SELECT payload_json FROM evaluation_dataset_snapshots WHERE snapshot_id=?",
            (args.snapshot,),
        ).fetchone()
        if snapshot is None:
            raise ValueError("Evaluation snapshot does not exist")
        dataset = json.loads(snapshot[0])
        trials = [
            (task_id, json.loads(config), json.loads(metrics))
            for task_id, config, metrics in db.execute(
                """SELECT task_id,config_json,metrics_json
                   FROM performance_tasks JOIN si_paths USING(path_id)
                   WHERE state='completed' AND dataset_snapshot_id=?""", (args.snapshot,),
            )
        ]
    if not trials:
        raise ValueError("No completed measured trials for this snapshot")
    if len({(m["corpus_revision"], m["dataset_revision"]) for _, _, m in trials}) != 1:
        raise ValueError("Trials do not have a comparable corpus and training budget")
    for _, _, metrics in trials:
        if metrics.get("evidence_type") != "real_query_retrieval" or not math.isfinite(metrics["recall_at_k"]):
            raise ValueError("Unverified or invalid measured result")
    task_id, config, metrics = max(
        trials, key=lambda row: (row[2]["recall_at_k"], row[2]["mrr"], row[0]),
    )
    documents, _ = load_pkm_skills(args.pkm_root)
    serialized = []
    for document in documents:
        value = asdict(document)
        value["skill_id"] = value.pop("version")["skill_id"]
        serialized.append(value)
    release = {
        "schema": "pkm.skill-serving/v1", "config": config,
        "documents": serialized, "weights": metrics["weights_after"],
        "validation": {
            "task_id": task_id, "dataset_snapshot_id": args.snapshot,
            "dataset_revision": metrics["dataset_revision"],
            "corpus_revision": metrics["corpus_revision"],
            "recall_at_k": metrics["recall_at_k"], "mrr": metrics["mrr"],
            "validation_query_count": metrics["validation_query_count"],
            "completed_comparable_trials": len(trials),
            "selected_at": datetime.now(timezone.utc).isoformat(),
            "claim": "provisional validation winner among completed comparable trials; not test performance",
        },
    }
    envelope = {"release": release, "sha256": canonical_digest(release)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise FileExistsError("Release output already exists; use a new immutable release path")
    with tempfile.TemporaryDirectory(dir=args.output.parent, prefix="verify-serving-") as temp:
        pending = Path(temp) / "release.json"
        pending.write_text(json.dumps(envelope, ensure_ascii=False))
        path = FrozenSkillPath(pending)
        expected = {row["query_id"]: row["ranking"] for row in metrics["validation_lineage"]}
        for row in dataset["validation_anchor"]:
            ranking = [hit.skill_version.skill_id for hit in path.search(row["query"], 5)]
            if ranking != expected[row["query_id"]]:
                raise ValueError("Frozen serving replay differs from evaluated validation rankings")
        verification_db = Path(temp) / "current.sqlite3"
        with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(verification_db) as target:
            source.backup(target)
        current = CollectorStore(verification_db, pkm_root=args.pkm_root)
        current.evaluation_dataset(task_id, require_current=True)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(pending.read_text())
    print(json.dumps({
        "release_id": envelope["sha256"], "architecture": path.architecture_id,
        "validation": release["validation"], "replay_verified": True,
        "artifact": str(args.output),
    }))


if __name__ == "__main__":
    main()
