"""Independent direct original-source learner oracle; no generated adapter imports."""
import ast
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import threading
from types import SimpleNamespace

request = json.load(sys.stdin)
source = Path(__file__).resolve().parents[2] / "resources/retrieval_solutions.py"
node, = [node for node in ast.parse(source.read_text(encoding="utf-8")).body
         if isinstance(node, ast.ClassDef) and node.name == "RetrievalLearning"]
namespace = dict(globals(), os=SimpleNamespace(chmod=lambda *_args: None))
exec(compile(ast.Module(body=[node], type_ignores=[]), "<independent-original-RetrievalLearning>", "exec"), namespace)
connections = []
connect = sqlite3.connect
def memory_connect(path, *args, **kwargs):
    assert path == ":memory:", "Original oracle must never connect to a filesystem database"
    connections.append(path)
    return connect(path, *args, **kwargs)
sqlite3.connect = memory_connect
database = sqlite3.connect(":memory:")
class Root:
    def __truediv__(self, _name):
        return ":memory:"
class Oracle(namespace["RetrievalLearning"]):
    def connect(self):
        return database
learner = Oracle(Root())
for name, rows in request["state"].items():
    assert name in {"settings", "models", "calls", "query_judgments"}
    database.execute(f"DELETE FROM {name}")
    if rows:
        database.executemany(f"INSERT INTO {name} VALUES ({','.join('?' for _ in rows[0])})", rows)
learner.salt = database.execute("SELECT value FROM settings WHERE key='salt'").fetchone()[0]
database.commit()
args = request["feedback"]
try:
    result = learner.feedback(args["retrieval_id"], args["relevant_source_ids"], args["complete"], args.get("provenance", "model"))
except ValueError as error:
    result = {"ok": False, "error": str(error)}
state = {name: [list(row) for row in database.execute(f"SELECT * FROM {name} ORDER BY " +
         ("key" if name == "settings" else "context" if name == "models" else "id" if name == "calls" else "context,query_key"))]
         for name in request["state"]}
database.close()
print(json.dumps({"result": result, "state": state, "connections": connections}, ensure_ascii=False))
