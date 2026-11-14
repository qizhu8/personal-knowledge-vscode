"""Owned disposable original learner file; never operates on a real/source workspace."""
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading

root = Path(__file__).resolve().parents[2]
node, = [node for node in ast.parse((root / "resources/retrieval_solutions.py").read_text()).body
         if isinstance(node, ast.ClassDef) and node.name == "RetrievalLearning"]
exec(compile(ast.Module(body=[node], type_ignores=[]), "<actual-original-owned-history-fixture>", "exec"))
request = json.load(sys.stdin)
learner = RetrievalLearning(Path(sys.argv[1]))
with learner.connect() as database:
    for name, rows in request["state"].items():
        assert name in {"settings", "models", "calls", "query_judgments"}
        database.execute("DELETE FROM " + name)
        if rows:
            database.executemany("INSERT INTO " + name + " VALUES (" + ",".join("?" for _ in rows[0]) + ")", rows)
    if request.get("predecessor"):
        for table, width in [("models", 11), ("calls", 14)]:
            names = [row[1] for row in database.execute("PRAGMA table_info(" + table + ")")]
            for column in reversed(names[width:]):
                database.execute("ALTER TABLE " + table + " DROP COLUMN " + column)
        database.execute("DELETE FROM settings WHERE key='learner_version'")
