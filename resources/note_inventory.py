"""Read-only, revision-checked directory inventory for Note discovery."""

import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit


def _directory(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("directory must be a Notes-relative path.")
    value = value.strip()
    if value.startswith("pkm://notes/"):
        parsed = urlsplit(value)
        if parsed.netloc != "notes" or parsed.query or parsed.fragment:
            raise ValueError("Use a Notes folder path without queries or fragments.")
        value = unquote(parsed.path[1:])
    elif value.startswith("notes/"):
        value = value[len("notes/"):]
    if value.startswith("/"):
        raise ValueError("directory must be Notes-relative, not an absolute path.")
    value = value.rstrip("/")
    if value and (value.startswith("/") or any(not part or part in {".", ".."} or part.startswith(".")
            or part == "_assets" or part.lower().endswith(".assets") for part in value.split("/"))
            or any(char in value for char in "\\:") or any(ord(char) < 32 for char in value)):
        raise ValueError("directory must be a visible Notes-relative folder without traversal.")
    return value


def _scan(root, directory, recursive):
    base = root / directory
    for candidate in [root, *[root.joinpath(*Path(directory).parts[:i]) for i in range(1, len(Path(directory).parts) + 1)]]:
        if candidate.is_symlink():
            raise ValueError("Note inventory does not follow symlinks: " + str(candidate))
    if not base.is_dir():
        if not directory and not base.exists():
            return []
        raise ValueError("Notes directory was not found: " + directory)

    def failed(error):
        raise error

    files = []
    for current, directories, names in os.walk(base, onerror=failed, followlinks=False):
        directories[:] = sorted(name for name in directories if not name.startswith(".")
                                and name != "_assets" and not name.lower().endswith(".assets"))
        for name in directories:
            if (Path(current) / name).is_symlink():
                raise ValueError("Note inventory does not follow symlinks: " + str(Path(current) / name))
        for name in sorted(names):
            if name.startswith(".") or not name.lower().endswith(".md"):
                continue
            file = Path(current) / name
            if file.is_symlink():
                raise ValueError("Note inventory does not follow symlinks: " + str(file))
            metadata = file.stat()
            files.append((file, file.relative_to(root).as_posix()[:-3], metadata.st_size, metadata.st_mtime_ns))
        if not recursive:
            directories[:] = []
    return sorted(files, key=lambda item: item[1])


def note_inventory_page(root, read_note, *, directory=None, recursive=True, offset=0,
                        limit=50, note_type=None, inventory_revision=None):
    if type(recursive) is not bool:
        raise ValueError("recursive must be a boolean.")
    if type(offset) is not int or offset < 0 or type(limit) is not int or limit < 0:
        raise ValueError("Choose a non-negative offset and limit; limit=0 returns all remaining matches.")
    if inventory_revision is not None and (not isinstance(inventory_revision, str)
            or not re.fullmatch(r"[a-f0-9]{64}", inventory_revision)):
        raise ValueError("Use the inventory_revision returned by the first page.")
    if offset and inventory_revision is None:
        raise ValueError("Later pages require the inventory_revision returned by offset 0.")
    directory = _directory(directory)
    root = Path(root)
    before = _scan(root, directory, recursive)
    rows = []
    for file, slug, _, _ in before:
        row = read_note(file, slug)
        if note_type and note_type != "all" and row["type"] != note_type:
            continue
        identity = row.get("knowledge_id")
        identity = identity if isinstance(identity, str) and re.fullmatch(r"knowledge_[a-f0-9]{24}", identity) else None
        rows.append({key: row[key] for key in ("slug", "title", "type", "documentKind", "category", "updated_at")} | {
            "knowledge_id": identity,
            "source_id": "pkm://knowledge/" + identity if identity else "pkm://notes/" + quote(slug, safe="/") + ".md",
            "identity_status": "stable" if identity else "missing",
            "read_only": row.get("read_only", False),
            "file_hash": hashlib.sha256(file.read_bytes()).hexdigest(),
        })
    if before != _scan(root, directory, recursive):
        raise ValueError("Notes changed during inventory; restart from offset 0.")
    identities = {}
    for row in rows:
        if row["knowledge_id"]:
            identities[row["knowledge_id"]] = identities.get(row["knowledge_id"], 0) + 1
    for row in rows:
        if identities.get(row["knowledge_id"], 0) > 1:
            row["identity_status"] = "duplicate"
    revision = hashlib.sha256(json.dumps({"directory": directory, "recursive": recursive,
        "type": note_type, "notes": rows}, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    if inventory_revision is not None and inventory_revision != revision:
        raise ValueError("Note inventory changed between pages; restart from offset 0.")
    end = len(rows) if limit == 0 else offset + limit
    return {"schema": "pkm.note-inventory/v1", "ok": True, "directory": directory,
            "recursive": recursive, "inventory_revision": revision, "complete": True,
            "identity_complete": all(row["identity_status"] == "stable" for row in rows),
            "missing_identity_count": sum(row["identity_status"] == "missing" for row in rows),
            "duplicate_identity_count": sum(row["identity_status"] == "duplicate" for row in rows),
            "total": len(rows), "offset": offset, "limit": limit,
            "returned": len(rows[offset:end]), "has_more": end < len(rows),
            "next_offset": end if end < len(rows) else None, "notes": rows[offset:end]}
