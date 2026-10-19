"""Bounded JSON-lines protocol over private parent/child stdio, never a network listener."""
import argparse
import json
import sqlite3
import sys

from . import Engine, MemoryError
from .memory import Memory

MAX_REQUEST = 8 * 1024 * 1024


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--identity", required=True)
    args = parser.parse_args()
    engine = Engine(args.database, args.identity)
    memory = Memory(engine)
    reads = {"capabilities": engine.capabilities, "read": engine.read, "neighbors": engine.neighbors,
             "sources": engine.sources, "changes": engine.changes, "embedding": engine.embedding,
             "pieces": engine.pieces, "children": engine.children, "parents": engine.parents,
             "usage": engine.usage}
    policy = {"turn_begin": memory.turn_begin, "turn_continue": memory.turn_continue,
              "turn_commit": memory.turn_commit, "turn_receipt": memory.turn_receipt,
              "memory_read": memory.memory_read, "overview": memory.overview,
              "enforce_capacity": memory.enforce_capacity, "forget_scope": memory.forget_scope}
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
            if not line:
                break
            if len(line) > MAX_REQUEST:
                print(json.dumps({"ok": False, "error": "Request exceeds 8 MiB; worker closed."}), flush=True)
                break
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or request.get("protocol") != 1:
                    raise MemoryError("Expected protocol 1 request object.")
                request_id = request.get("id")
                method, params = request["method"], request.get("params", {})
                if not isinstance(params, dict):
                    raise MemoryError("params must be an object.")
                if method in reads:
                    result = reads[method](**params)
                elif method in policy:
                    result = policy[method](**params)
                else:
                    result = engine.mutate(request["operation_id"], method, params)
                response = {"id": request_id, "ok": True, "result": result}
            except (ValueError, sqlite3.Error, KeyError, TypeError, OverflowError) as error:
                response = {"id": request_id, "ok": False,
                            "error": {"type": type(error).__name__, "message": str(error)}}
            print(json.dumps(response, allow_nan=False, ensure_ascii=False), flush=True)
    finally:
        engine.close()


if __name__ == "__main__":
    main()
