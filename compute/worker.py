"""Private Chat computation transport; explicit memory remains in Node Markdown."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

if sys.version_info < (3, 10):
    raise RuntimeError("Python 3.10 or newer is required for Chat computation.")

# -I excludes ambient Python imports, including the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pkm_memory_engine import Engine, Memory, MemoryError


def reject_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--max-request-bytes", type=int, required=True)
    parser.add_argument("--max-response-bytes", type=int, required=True)
    args = parser.parse_args()
    if not all(256 <= limit <= 8 * 1024 * 1024 for limit in
               (args.max_request_bytes, args.max_response_bytes)):
        raise ValueError("Invalid transport byte limits.")
    engine = Engine(args.database, args.identity)
    memory = Memory(engine)
    reads = {name: getattr(engine, name) for name in
             ("read", "neighbors", "sources", "changes", "embedding", "pieces",
              "children", "parents", "usage")}
    policy = {name: getattr(memory, name) for name in
              ("turn_begin", "turn_continue", "turn_abort", "turn_commit",
               "turn_receipt", "memory_read", "overview", "enforce_capacity", "forget_scope")}
    mutations = {"create", "append", "link", "summary_commit", "embedding_put",
                 "touch", "evict", "purge_chat", "lease_acquire", "lease_release"}

    def emit(value: object) -> None:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
        if len(encoded) > args.max_response_bytes:
            # A committed mutation can already have happened; never invent a negative receipt.
            raise RuntimeError("Compute response exceeded configured byte limit; outcome may be uncertain.")
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

    try:
        emit({"type": "ready", "protocol": 1, "adapter": "pkm-next-chat-compute/1",
              "module": "pkm-memory-engine", "policy": "pkm-memory-policy/1",
              "schema": 2, "identity": engine.identity, "storage": "worker-owned-runtime-sqlite",
              "explicit_memory": "node-markdown", "capabilities": engine.capabilities()})
        while True:
            line = sys.stdin.buffer.readline(args.max_request_bytes + 1)
            if not line:
                break
            if len(line) > args.max_request_bytes or not line.endswith(b"\n"):
                raise ValueError("Compute request exceeded limit or was truncated.")
            request_id = None
            try:
                request = json.loads(line, parse_constant=reject_constant)
                if not isinstance(request, dict) or request.get("protocol") != 1:
                    raise MemoryError("Expected protocol 1 request object.")
                request_id = request.get("id")
                if not isinstance(request_id, str) or not request_id or len(request_id) > 100:
                    raise MemoryError("Invalid request identity.")
                method, params = request.get("method"), request.get("params")
                if not isinstance(method, str) or not isinstance(params, dict):
                    raise MemoryError("Expected a method and object params.")
                if method in reads:
                    result = reads[method](**params)
                elif method in policy:
                    result = policy[method](**params)
                elif method in mutations:
                    result = engine.mutate(request["operation_id"], method, params)
                else:
                    raise MemoryError("Unsupported Chat computation method.", "ACCESS_DENIED")
                response = {"id": request_id, "ok": True, "result": result}
            except (ValueError, sqlite3.Error, KeyError, TypeError, OverflowError) as error:
                response = {"id": request_id, "ok": False, "error": {
                    "type": type(error).__name__, "code": getattr(error, "code", "INVALID_ARGUMENT"),
                    "message": str(error)}}
            emit(response)
    finally:
        engine.close()


if __name__ == "__main__":
    main()
