"""Bounded, process-isolated PKM diagnostic records and local tail export."""

import argparse
import collections
import datetime
import json
import math
import os
import pathlib
import threading
import uuid


MAX_ROWS = 100_000
CHUNK_ROWS = 1_000


class DiagnosticLog:
    def __init__(self, directory, max_rows=MAX_ROWS, chunk_rows=CHUNK_ROWS):
        if max_rows < 1 or chunk_rows < 1:
            raise ValueError("Log capacities must be positive")
        self.directory = pathlib.Path(directory)
        self.max_rows = max_rows
        self.chunk_rows = min(chunk_rows, max_rows)
        self.writer_id = f"{os.getpid()}-{uuid.uuid4().hex}"
        self.sequence = 0
        self.rows = 0
        self.dropped = 0
        self._lock = threading.Lock()

    def record(self, event, **fields):
        with self._lock:
            try:
                self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                if self.rows >= self.chunk_rows:
                    self.sequence += 1
                    self.rows = 0
                entry = {
                    "schema": "pkm.diagnostic/v1",
                    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "pid": os.getpid(),
                    "writerId": self.writer_id,
                    "event": str(event)[:80],
                    **{key: value if not isinstance(value, str) else value[:160]
                       for key, value in fields.items()
                       if isinstance(value, (str, int, float, bool)) or value is None},
                    "dropped": self.dropped,
                }
                line = json.dumps(entry, ensure_ascii=True, separators=(",", ":"))
                if len(line) > 4096:
                    self.dropped += 1
                    return
                filename = self.directory / f"{self.writer_id}.{self.sequence:010d}.jsonl"
                descriptor = os.open(filename, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
                self.rows += 1
                keep_chunks = math.ceil(self.max_rows / self.chunk_rows) + 1
                obsolete = self.sequence - keep_chunks
                if obsolete >= 0:
                    (self.directory / f"{self.writer_id}.{obsolete:010d}.jsonl").unlink(missing_ok=True)
            except (OSError, ValueError, TypeError):
                self.dropped += 1

    def latest(self, limit=200):
        return latest(self.directory, self.writer_id, limit, self.max_rows)


def latest(directory, writer_id, limit=200, max_rows=MAX_ROWS):
    if not 1 <= limit <= max_rows:
        raise ValueError(f"limit must be between 1 and {max_rows}")
    if not writer_id or any(character not in "0123456789abcdef-" for character in writer_id):
        raise ValueError("Invalid writer ID")
    result = collections.deque()
    paths = sorted(pathlib.Path(directory).glob(f"{writer_id}.*.jsonl"), reverse=True)
    for filename in paths:
        try:
            lines = filename.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(entry, dict) or entry.get("schema") != "pkm.diagnostic/v1":
                continue
            result.appendleft(entry)
            if len(result) >= limit:
                return list(result)
    return list(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--writer", help="Writer ID; omit to list available writers")
    parser.add_argument("--latest", type=int, default=200)
    args = parser.parse_args()
    if not args.writer:
        writers = sorted({filename.name.split(".")[0]
                          for filename in pathlib.Path(args.directory).glob("*.jsonl")})
        print(json.dumps({"writers": writers, "maxRowsPerWriter": MAX_ROWS}))
        return
    for entry in latest(args.directory, args.writer, args.latest):
        print(json.dumps(entry, ensure_ascii=True))


if __name__ == "__main__":
    main()