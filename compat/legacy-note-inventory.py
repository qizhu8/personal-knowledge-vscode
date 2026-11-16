import datetime
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legacy" / "resources"))
from note_inventory import note_inventory_page


def parse(text):
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not match:
        return {}, text
    metadata = {}
    for line in match.group(1).splitlines():
        index = line.find(":")
        if index < 0:
            continue
        key, raw = line[:index].strip(), line[index + 1:].strip()
        if not key:
            continue
        try:
            metadata[key] = json.loads(raw)
        except json.JSONDecodeError:
            metadata[key] = raw.strip("\"'")
    return metadata, text[match.end():]


def note(path, slug):
    metadata, _ = parse(path.read_text(encoding="utf-8"))
    identity = metadata.get("knowledgeId")
    identity = identity if isinstance(identity, str) and re.fullmatch(r"knowledge_[a-f0-9]{24}", identity) else None
    board = path.with_name(path.stem + ".assets") / "pkm-todo-board.json"
    parts = path.relative_to(root).parts
    return {
        "slug": slug,
        "title": metadata.get("title") or slug.rsplit("/", 1)[-1],
        "knowledge_id": identity,
        "documentKind": "todo-board" if metadata.get("documentKind") == "todo-board" or board.exists() else "markdown",
        "type": metadata.get("type") or "general",
        "category": slug.rpartition("/")[0],
        "updated_at": datetime.datetime.utcfromtimestamp(path.stat().st_mtime).isoformat(),
        "read_only": len(parts) > 1 and parts[0].casefold() == "system",
    }


root = Path(sys.argv[1]) / "notes"
arguments = json.load(sys.stdin)
result = note_inventory_page(
    root, note, directory=arguments.get("directory"), recursive=arguments.get("recursive", True),
    offset=arguments.get("offset", 0), limit=arguments.get("limit", 50),
    note_type=arguments.get("type"), inventory_revision=arguments.get("inventory_revision"),
)
json.dump(result, sys.stdout, ensure_ascii=False)
