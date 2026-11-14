import ast
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid
from zoneinfo import ZoneInfo

source = Path(__file__).with_name("legacy-knowledge-snapshots-captured.py").read_bytes()
if hashlib.sha256(source).hexdigest() != "406527c1886d1228d690d67586cf68e70b58ce7fb7b948b60f6e0ac6ca577fd8":
    raise ValueError("Original Knowledge snapshot capture changed")
nodes = [node for node in ast.parse(source).body
         if isinstance(node, (ast.FunctionDef, ast.ClassDef))
         and node.name in ("_sha", "_json", "next_run", "KnowledgeSnapshots")]
AREAS = ("skills", "notes", "papers", "prompts", "scripts")
UTC = timezone.utc
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<actual-original-knowledge-snapshots>", "exec"))

request = json.load(sys.stdin)
root = Path(request["root"])
state = Path(request["state"])
repository = state / "repository.git"
def checked_parents(path):
    if not path.is_absolute() or not (path.is_relative_to(root) or path.is_relative_to(state)):
        raise ValueError("Snapshot data must remain inside its fixed workspace/private state")
    for parent in path.parents:
        metadata = parent.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise ValueError("Snapshot data refuses linked or non-directory parents")

def secure_read_bytes(path):
    checked_parents(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError("Snapshot data refuses linked or nonregular files")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        content = stream.read()
        after = os.fstat(stream.fileno())
    current = path.lstat()
    checked_parents(path)
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_nlink")
    if any(any(getattr(value, key) != getattr(before, key) for key in fields)
           for value in (opened, after, current)) or len(content) != before.st_size:
        raise RuntimeError("Snapshot data changed while reading its pinned file descriptor")
    return content

def secure_read_text(path, encoding=None, errors=None):
    with io.TextIOWrapper(io.BytesIO(secure_read_bytes(path)), encoding=encoding or "utf-8", errors=errors) as stream:
        return stream.read()

Path.read_bytes = secure_read_bytes
Path.read_text = secure_read_text
real_run = subprocess.run
def safe_run(argv, **kwargs):
    allowed = {"hash-object", "update-index", "write-tree", "for-each-ref", "commit-tree", "mktag",
               "update-ref", "tag", "rev-parse", "ls-tree", "cat-file"}
    if argv[:3] == ["git", "init", "--bare"] and len(argv) == 4 and argv[3] == str(repository):
        pass
    elif len(argv) >= 3 and argv[0] == "git" and argv[1] == "--git-dir=" + str(repository) and argv[2] in allowed:
        pass
    else:
        raise ValueError("Only fixed private local Git object/ref operations are authorized")
    supplied = kwargs.pop("env", {})
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_GLOBAL": os.devnull,
                   "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
                   "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.hooksPath",
                   "GIT_CONFIG_VALUE_0": os.devnull, "GIT_CONFIG_KEY_1": "protocol.allow",
                   "GIT_CONFIG_VALUE_1": "never", "TMPDIR": str(state)}
    for key in ("GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        if key in supplied:
            environment[key] = supplied[key]
    return real_run(argv, env=environment, **kwargs)
subprocess.run = safe_run
snapshots = KnowledgeSnapshots(root)
snapshots.state = state
snapshots.repository = repository
operation = request["operation"]
arguments = request.get("args", {})
if operation == "create":
    result = snapshots._create(arguments.get("reason", "manual"))
elif operation == "status":
    result = snapshots.status()
elif operation == "preview":
    result = snapshots.restore_preview(arguments["tag"])
elif operation == "plan":
    identifier = arguments["preview_id"]
    if not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise ValueError("Invalid preview ID")
    raw = (state / "previews" / (identifier + ".json")).read_bytes()
    if _sha(raw) != arguments["approved_sha256"]:
        raise ValueError("Restore preview changed")
    result = json.loads(raw)
    if result["knowledge_root"] != str(root) or snapshots.fingerprint(snapshots.inventory()) != result["inventory_sha256"]:
        raise ValueError("Knowledge changed after preview")
    for change in result["changes"]:
        if change["target"]:
            raw = snapshots.git("cat-file", "blob", change["target"]["object"])
            if _sha(raw) != change["target"]["sha256"]:
                raise ValueError("Snapshot blob changed")
            import base64
            change["target"]["bytes"] = base64.b64encode(raw).decode()
elif operation == "timing":
    result = next_run(arguments["local_time"], arguments["timezone"],
                      datetime.fromisoformat(arguments["now"]) if "now" in arguments else None)
elif operation == "inventory":
    files = snapshots.inventory()
    result = {"sha256": snapshots.fingerprint(files),
              "files": {path: {"mode": row["mode"], "sha256": row["sha256"]} for path, row in files.items()}}
else:
    raise ValueError("Unsupported local snapshot operation")
print(json.dumps(result, ensure_ascii=False))
