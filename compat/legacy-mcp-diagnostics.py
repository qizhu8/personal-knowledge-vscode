"""Bounded pagination over actual original diagnostic JSONL records."""

import base64
import hashlib
import json
import os
import re
import stat
from pathlib import Path

WRITER = re.compile(r"^[0-9]+-[a-f0-9]{32}$")
CHUNK = re.compile(r"^([0-9]+-[a-f0-9]{32})\.([0-9]{10})\.jsonl$")
MAX_CHUNKS = 101
MAX_CHUNK_BYTES = 1000 * 4097


def _chunks(directory, writer=None):
    found = []
    for count, path in enumerate(Path(directory).iterdir(), 1):
        if count > 20000:
            raise ValueError("Diagnostic directory exceeds the bounded inventory")
        match = CHUNK.fullmatch(path.name)
        if match and (writer is None or match[1] == writer):
            found.append((match[1], int(match[2])))
            if len(found) > (MAX_CHUNKS if writer else 10000):
                raise ValueError("Diagnostic directory exceeds the bounded inventory")
    return sorted(found)


def writers(directory, offset=0, limit=50, revision=None):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Invalid diagnostic writer page")
    ids = sorted({writer for writer, _ in _chunks(directory)})
    digest = hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest()
    if (offset and revision is None) or (revision is not None and revision != digest):
        raise ValueError("Diagnostic writer inventory changed; restart pagination")
    return {"writer_ids": ids[offset:offset + limit], "revision": digest,
            "next_offset": offset + limit if offset + limit < len(ids) else None}


def _read_chunk(directory, writer, sequence, size=None, digest=None):
    path = Path(directory) / f"{writer}.{sequence:010d}.jsonl"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise ValueError("Invalid diagnostic file")
            length = info.st_size if size is None else size
            if length < 1 or length > MAX_CHUNK_BYTES or info.st_size < length:
                raise ValueError("Diagnostic chunk expired or exceeds bounds")
            content = stream.read(length)
    except OSError as error:
        raise ValueError("Diagnostic chunk expired or unavailable") from error
    if len(content) != length or not content.endswith(b"\n"):
        raise ValueError("Diagnostic chunk is incomplete")
    actual = hashlib.sha256(content).hexdigest()
    if digest is not None and actual != digest:
        raise ValueError("Diagnostic chunk changed; restart pagination")
    lines = content.splitlines()
    if not 1 <= len(lines) <= 1000 or any(len(line) > 4096 for line in lines):
        raise ValueError("Diagnostic chunk exceeds record bounds")
    records = []
    for line in lines:
        try:
            record = json.loads(line)
            if not isinstance(record, dict) or record.get("schema") != "pkm.diagnostic/v1" or record.get("writerId") != writer:
                raise ValueError("Invalid diagnostic record")
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError("Invalid diagnostic record") from error
        records.append(record)
    return records, length, actual


def history_page(directory, writer, limit=100, cursor=None):
    if not isinstance(writer, str) or not WRITER.fullmatch(writer) or type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("Invalid diagnostic writer or limit")
    if cursor is None:
        chunks = _chunks(directory, writer)
        if not chunks:
            raise ValueError("Diagnostic writer not found")
        sequences = [sequence for _, sequence in chunks]
        if sequences != list(range(sequences[0], sequences[-1] + 1)):
            raise ValueError("Diagnostic chunks are missing")
        manifest = []
        for sequence in sequences:
            records, length, digest = _read_chunk(directory, writer, sequence)
            if sequence != sequences[-1] and len(records) != 1000:
                raise ValueError("Diagnostic chunks are incomplete")
            manifest.append([sequence, length, len(records), digest])
        total = sum(item[2] for item in manifest)
        state = {"v": 1, "writer": writer, "chunks": manifest, "position": total, "floor": max(0, total - 100000)}
    else:
        try:
            if not isinstance(cursor, str) or len(cursor) > 24000:
                raise ValueError()
            state = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
            manifest = state["chunks"]
            if (set(state) != {"v", "writer", "chunks", "position", "floor"} or state["v"] != 1 or state["writer"] != writer
                    or not isinstance(manifest, list) or not 1 <= len(manifest) <= MAX_CHUNKS):
                raise ValueError()
            for item in manifest:
                if (not isinstance(item, list) or len(item) != 4 or any(type(item[i]) is not int for i in range(3))
                        or not 0 <= item[0] <= 9999999999 or not 1 <= item[1] <= MAX_CHUNK_BYTES
                        or not 1 <= item[2] <= 1000 or not isinstance(item[3], str) or not re.fullmatch(r"[a-f0-9]{64}", item[3])):
                    raise ValueError()
            if any(manifest[i][0] != manifest[i - 1][0] + 1 or manifest[i - 1][2] != 1000 for i in range(1, len(manifest))):
                raise ValueError()
            total = sum(item[2] for item in manifest)
            if (type(state["floor"]) is not int or state["floor"] != max(0, total - 100000)
                    or type(state["position"]) is not int or not state["floor"] <= state["position"] <= total):
                raise ValueError()
        except (ValueError, TypeError, KeyError, UnicodeDecodeError) as error:
            raise ValueError("Invalid diagnostic history cursor") from error
    result = []
    position = state["position"]
    end = total
    for sequence, length, count, digest in reversed(manifest):
        start = end - count
        if position > start and position > state["floor"] and len(result) < limit:
            records, _, _ = _read_chunk(directory, writer, sequence, length, digest)
            if len(records) != count:
                raise ValueError("Diagnostic chunk changed; restart pagination")
            while position > max(start, state["floor"]) and len(result) < limit:
                position -= 1
                result.append(records[position - start])
        end = start
        if len(result) == limit or position <= state["floor"]:
            break
    state["position"] = position
    next_cursor = base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode() if position > state["floor"] else None
    return {"ok": True, "writer_id": writer, "records": result, "next_cursor": next_cursor}


def page(log, limit, cursor):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("limit must be between 1 and 1000")
    with log._lock:
        total = log.sequence * log.chunk_rows + log.rows
        if cursor is None:
            upper, position = total, total
            floor = max(0, upper - log.max_rows)
        else:
            match = re.fullmatch(r"([0-9a-f-]+):(\d+):(\d+):(\d+)", cursor) if len(cursor) <= 128 else None
            if not match or match[1] != log.writer_id:
                raise ValueError("Invalid or foreign diagnostic cursor")
            upper, position, floor = map(int, match.groups()[1:])
            if upper > total or floor != max(0, upper - log.max_rows) or not floor <= position <= upper:
                raise ValueError("Invalid diagnostic cursor")
        records = []
        cached_chunk = None
        lines = []
        while position > floor and len(records) < limit:
            index = position - 1
            chunk, row = divmod(index, log.chunk_rows)
            if chunk != cached_chunk:
                path = Path(log.directory) / f"{log.writer_id}.{chunk:010d}.jsonl"
                try:
                    lines = path.read_text(encoding="utf-8").splitlines()
                except OSError as error:
                    raise ValueError("Diagnostic page expired or became unavailable") from error
                cached_chunk = chunk
            try:
                entry = json.loads(lines[row])
                if not isinstance(entry, dict) or entry.get("schema") != "pkm.diagnostic/v1" or entry.get("writerId") != log.writer_id:
                    raise ValueError("Invalid diagnostic record")
            except (IndexError, ValueError, TypeError) as error:
                raise ValueError("Diagnostic page expired or became invalid") from error
            records.append(entry)
            position -= 1
        next_cursor = f"{log.writer_id}:{upper}:{position}:{floor}" if position > floor else None
        return {"ok": True, "writer_id": log.writer_id, "records": records, "next_cursor": next_cursor}
