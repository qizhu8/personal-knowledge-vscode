import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import secrets
import sqlite3
import threading
from types import SimpleNamespace
import sys

TABLES = {
    "settings": ["key", "value"],
    "models": ["context", "package", "corpus", "route", "slope", "bias", "threshold", "samples", "safe_streak",
               "weights", "revision", "model_labels", "user_labels", "prequential"],
    "calls": ["id", "receipt", "context", "milliseconds", "returned", "candidates", "cut", "eligible", "recall",
              "label_digest", "success", "labels", "provenance", "version", "query_features", "brier", "log_loss",
              "query_key", "judged"],
    "query_judgments": ["context", "query_key", "receipt", "call_id", "candidates", "query_features", "labels",
                        "label_digest", "version"],
}


def execute(snapshot, work, upgrade=None):
    spec = importlib.util.spec_from_file_location("original_learning", Path(__file__).with_name("legacy-retrieval-learning-captured.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    database = sqlite3.connect(":memory:")
    allowed_tables = set(TABLES) | {"sqlite_master", "sqlite_temp_master", "sqlite_sequence"}
    initializing = True
    def authorize(action, first, second, _database, _trigger):
        if action == sqlite3.SQLITE_ALTER_TABLE:
            return sqlite3.SQLITE_OK if initializing and first == "main" and second in ("models", "calls") else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH,
                      sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_CREATE_VTABLE, sqlite3.SQLITE_DROP_VTABLE):
            return sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE,
                      sqlite3.SQLITE_DELETE, sqlite3.SQLITE_CREATE_TABLE) and first not in allowed_tables:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and (first != "table_info" or second not in TABLES):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and second in ("load_extension", "readfile", "writefile"):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    database.set_authorizer(authorize)
    module.__dict__.update({"hashlib": hashlib, "json": json, "math": math, "re": re, "secrets": secrets,
                            "sqlite3": sqlite3, "threading": threading, "Path": Path,
                            "os": SimpleNamespace(chmod=lambda path, mode: None)})
    class MemoryState:
        def __truediv__(self, _name):
            return ":memory:"
    class NativeLearning(module.RetrievalLearning):
        def connect(self):
            return database
    try:
        if upgrade is not None:
            if not isinstance(upgrade, dict) or set(upgrade) != {"columns", "tables"}:
                raise ValueError("Invalid closed original learner upgrade snapshot")
            specifications = {
                "settings": ["key TEXT PRIMARY KEY", "value TEXT NOT NULL"],
                "models": ["context TEXT PRIMARY KEY", "package TEXT", "corpus TEXT", "route TEXT",
                           "slope REAL", "bias REAL", "threshold REAL", "samples INTEGER", "safe_streak INTEGER",
                           "weights TEXT NOT NULL DEFAULT '[]'", "revision INTEGER NOT NULL DEFAULT 0",
                           "model_labels INTEGER NOT NULL DEFAULT 0", "user_labels INTEGER NOT NULL DEFAULT 0",
                           "prequential TEXT NOT NULL DEFAULT '{}'"],
                "calls": ["id INTEGER PRIMARY KEY AUTOINCREMENT", "receipt TEXT UNIQUE", "context TEXT",
                          "milliseconds REAL", "returned INTEGER", "candidates TEXT", "cut INTEGER",
                          "eligible INTEGER", "recall REAL", "label_digest TEXT", "success INTEGER",
                          "labels TEXT", "provenance TEXT", "version INTEGER NOT NULL DEFAULT 0",
                          "query_features TEXT NOT NULL DEFAULT '[]'", "brier REAL", "log_loss REAL",
                          "query_key TEXT", "judged TEXT"],
                "query_judgments": ["context TEXT NOT NULL", "query_key TEXT NOT NULL", "receipt TEXT NOT NULL",
                                    "call_id INTEGER NOT NULL", "candidates TEXT NOT NULL", "query_features TEXT NOT NULL",
                                    "labels TEXT NOT NULL", "label_digest TEXT NOT NULL", "version INTEGER NOT NULL",
                                    "PRIMARY KEY(context,query_key)"],
            }
            if set(upgrade["columns"]) != set(TABLES) or set(upgrade["tables"]) != set(TABLES):
                raise ValueError("Closed original learner upgrade has unknown or missing tables")
            for name, columns in upgrade["columns"].items():
                if name == "query_judgments" and columns == [] and upgrade["tables"][name] == []:
                    if len(upgrade["columns"]["models"]) != 9 or len(upgrade["columns"]["calls"]) != 11:
                        raise ValueError("Missing original query judgments is admitted only for the complete base schema")
                    continue
                minimum = 9 if name == "models" else 11 if name == "calls" else len(TABLES[name])
                if not isinstance(columns, list) or not minimum <= len(columns) <= len(TABLES[name]) or columns != TABLES[name][:len(columns)]:
                    raise ValueError("Closed original learner upgrade columns are not an original prefix")
                rows = upgrade["tables"][name]
                if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != len(columns) for row in rows):
                    raise ValueError("Closed original learner upgrade row width differs")
                definitions = specifications[name] if name == "query_judgments" else specifications[name][:len(columns)]
                database.execute(f"CREATE TABLE {name} ({','.join(definitions)})")
                database.executemany(f"INSERT INTO {name} VALUES ({','.join('?' for _ in columns)})", rows)
            settings = dict(upgrade["tables"]["settings"])
            if set(settings) - {"salt", "enabled", "online_learning_opt_in_version", "learner_version"}:
                raise ValueError("Closed original learner upgrade has unknown settings")
            if not re.fullmatch("[a-f0-9]{64}", str(settings.get("salt", ""))) or settings.get("enabled") not in ("true", "false"):
                raise ValueError("Closed original learner upgrade salt or enabled setting differs")
            if "online_learning_opt_in_version" in settings and settings["online_learning_opt_in_version"] != "1":
                raise ValueError("Unsupported closed original learning opt-in version")
            if "learner_version" in settings and settings["learner_version"] != "2":
                raise ValueError("Unsupported closed original learner version")
            database.commit()
        learner = NativeLearning(MemoryState())
        initializing = False
        if snapshot is not None:
            if not isinstance(snapshot, dict) or set(snapshot) != set(TABLES):
                raise ValueError("Invalid native learner table snapshot.")
            for name, columns in TABLES.items():
                if [row[1] for row in database.execute(f"PRAGMA table_info({name})")] != columns:
                    raise ValueError("Original learner table schema changed.")
                rows = snapshot[name]
                if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != len(columns) for row in rows):
                    raise ValueError("Native learner rows differ from their exact fixed-table schema.")
                database.execute(f"DELETE FROM {name}")
                database.executemany(f"INSERT INTO {name} VALUES ({','.join('?' for _ in columns)})", rows)
            learner.salt = database.execute("SELECT value FROM settings WHERE key='salt'").fetchone()[0]
            database.commit()
        result = work(learner)
        state = {name: [list(row) for row in database.execute(f"SELECT * FROM {name} ORDER BY " +
                 ("key" if name == "settings" else "context" if name == "models" else "id" if name == "calls" else "context,query_key"))]
                 for name in TABLES}
        return result, state
    finally:
        database.close()


if __name__ == "__main__":
    _, state = execute(None, lambda _learner: None, upgrade=json.load(sys.stdin))
    print(json.dumps(state, ensure_ascii=False))
