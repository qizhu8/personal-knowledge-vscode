"""Opt-in synthetic disk benchmark; no private sources, model calls or persistent fixture."""
import argparse
import json
from pathlib import Path
import platform
import sqlite3
import sys
import tempfile
import time

from pkm_memory_engine import Engine


def percentile(samples):
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] * 1000


def memory_usage():
    if sys.platform == "linux":
        fields = {}
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith(("VmRSS:", "VmHWM:")):
                key, value, _ = line.split()
                fields[key[:-1]] = int(value) * 1024
        return fields
    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pieces", type=int, default=10000)
    parser.add_argument("--statements", type=int, default=10)
    parser.add_argument("--large-mib", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.pieces <= 100000 or not 1 <= args.statements <= 20 or not 0 <= args.large_mib <= 200:
        parser.error("Benchmark bounds: Pieces 1..100000, statements 1..20, large MiB 0..200.")
    started = time.perf_counter()
    memory = {"start": memory_usage()}
    with tempfile.TemporaryDirectory(prefix="pkm-memory-benchmark-") as directory:
        database = Path(directory) / "memory.sqlite3"
        engine = Engine(database, "synthetic-benchmark")
        try:
            body = "Synthetic memory evidence. " * 40
            append_times = []
            for i in range(args.pieces):
                piece = f"p-{i}"
                engine.mutate(f"create-{i}", "create", {"piece": piece, "label": piece})
                for j in range(args.statements):
                    operation = f"{i}-{j}"
                    tick = time.perf_counter()
                    engine.mutate(operation, "append", {
                        "piece": piece, "statement_id": operation, "body": body,
                        "expected_revision": j,
                        "sources": [{"id": operation, "chat": f"chat-{i % 100}",
                                     "revision": "synthetic-v1", "locator": operation}],
                    })
                    append_times.append(time.perf_counter() - tick)
            loaded_at = time.perf_counter()
            memory["after_load"] = memory_usage()
            reads = []
            for i in range(1000):
                tick = time.perf_counter()
                snapshot = engine.read(f"p-{i % args.pieces}")
                if len(snapshot["statements"]) != args.statements:
                    raise AssertionError("Benchmark page did not return the expected data.")
                reads.append(time.perf_counter() - tick)
            engine.mutate("large", "create", {"piece": "large", "label": "200 MiB synthetic Chat"})
            payload = "E" * 65536
            large_started = time.perf_counter()
            for i in range(args.large_mib * 16):
                operation = f"large-{i}"
                engine.mutate(operation, "append", {
                    "piece": "large", "statement_id": operation, "body": payload, "expected_revision": i,
                    "sources": [{"id": operation, "chat": "large-chat",
                                 "revision": "synthetic-v1", "locator": operation}],
                })
            tick = time.perf_counter()
            page = engine.read("large")
            large_read_ms = (time.perf_counter() - tick) * 1000
            engine.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            integrity = engine.db.execute("PRAGMA integrity_check").fetchone()[0]
            memory["after_large_chat"] = memory_usage()
            rss = memory["after_large_chat"].get("VmHWM")
            if sys.platform == "darwin":
                import resource
                rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            print(json.dumps({
                "scope": "single-process disk storage; no IPC, LLM, retrieval or four-client performance claim",
                "python": platform.python_version(), "sqlite": sqlite3.sqlite_version,
                "platform": platform.platform(), "pieces": args.pieces,
                "statements_per_piece": args.statements, "load_seconds": loaded_at - started,
                "append_one_p95_ms": percentile(append_times), "warm_page_p95_ms": percentile(reads),
                "large_chat_payload_mib": args.large_mib,
                "large_chat_write_seconds": time.perf_counter() - large_started,
                "large_chat_first_page_ms": large_read_ms,
                "large_page_bytes": len(json.dumps(page, ensure_ascii=False).encode()),
                "database_bytes": database.stat().st_size, "peak_rss_bytes": rss,
                "linux_memory_phases": memory,
                "integrity": integrity,
            }, indent=2))
        finally:
            engine.close()


if __name__ == "__main__":
    main()
